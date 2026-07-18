import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { feishuPatchData } from "../../packages/feishu/src/live.js";
import {
  OutboxDispatcher,
  type OutboxSendResult,
} from "../../packages/feishu/src/outbox-dispatcher.js";
import { createDiscussion } from "../../packages/domain/src/discussion.js";
import { createTopic } from "../../packages/domain/src/topic.js";
import { DiscussionControlDeliveryEffects } from "../../packages/orchestrator/src/discussion.js";
import { SqliteDiscussionStore } from "../../packages/storage/src/discussion.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

function openOutbox(): DurableOutbox {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-outbox-update-"));
  temporaryDirectories.push(directory);
  return DurableOutbox.open(join(directory, "test.db"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("updatable durable Outbox", () => {
  it("writes the created control message ID back and immediately patches the latest card", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-control-effect-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.db");
    const events = EventStore.open(path);
    const store = SqliteDiscussionStore.open(path);
    const topic = createTopic("Topic", "tenant-1:user:member-1", { id: "topic-1" });
    events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    store.createDiscussion(createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "question",
      starterPrincipalId: "tenant-1:user:member-1",
    }));
    const refreshed: string[] = [];
    const effects = new DiscussionControlDeliveryEffects({
      store,
      coordinator: { refreshControl: async (id) => { refreshed.push(id); } },
    });

    try {
      await effects.apply({
        id: "control-card",
        appRole: "hub",
        receiveId: "chat-1",
        payload: {},
        attempts: 0,
        nextAttemptAt: "2026-07-18T01:00:00.000Z",
        status: "delivered",
        idempotencyKey: "control-card",
        operation: "create",
        deliveryEffect: { kind: "discussion.control.created", discussionId: "discussion-1" },
      }, { messageId: "message-created" });

      expect(store.discussion("discussion-1")?.controlMessageId).toBe("message-created");
      expect(refreshed).toEqual(["discussion-1"]);
      await expect(effects.apply({
        id: "missing-result",
        appRole: "hub",
        receiveId: "chat-1",
        payload: {},
        attempts: 0,
        nextAttemptAt: "2026-07-18T01:00:00.000Z",
        status: "delivered",
        idempotencyKey: "missing-result",
        operation: "create",
        deliveryEffect: { kind: "discussion.control.created", discussionId: "discussion-1" },
      }, {})).rejects.toThrow(/message ID/i);
    } finally {
      store.close();
      events.close();
    }
  });

  it("persists create/update operations and the update target", () => {
    const outbox = openOutbox();
    try {
      outbox.enqueue({
        id: "create-card",
        appRole: "hub",
        receiveId: "chat-1",
        payload: { schema: "2.0" },
        idempotencyKey: "create-card",
        deliveryEffect: { kind: "discussion.control.created", discussionId: "discussion-1" },
      });
      outbox.enqueue({
        id: "update-card",
        appRole: "hub",
        receiveId: "chat-1",
        payload: { schema: "2.0", state: "paused" },
        idempotencyKey: "update-card-v2",
        operation: "update",
        targetMessageId: "message-1",
      });

      expect(outbox.pending("2099-01-01T00:00:00.000Z")).toEqual([
        expect.objectContaining({
          id: "create-card",
          operation: "create",
          deliveryEffect: { kind: "discussion.control.created", discussionId: "discussion-1" },
        }),
        expect.objectContaining({
          id: "update-card",
          operation: "update",
          targetMessageId: "message-1",
        }),
      ]);
    } finally {
      outbox.close();
    }
  });

  it("does not send a created card twice when its delivery effect retries", async () => {
    const outbox = openOutbox();
    outbox.enqueue({
      id: "control-card",
      appRole: "hub",
      receiveId: "chat-1",
      payload: { schema: "2.0" },
      idempotencyKey: "control-card",
      deliveryEffect: { kind: "discussion.control.created", discussionId: "discussion-1" },
    });
    const sends: string[] = [];
    const effects: OutboxSendResult[] = [];
    let effectAttempts = 0;
    const dispatcher = new OutboxDispatcher({
      outbox,
      sender: {
        send: async (message) => {
          sends.push(message.id);
          return { messageId: "message-created" };
        },
      },
      deliveryEffects: {
        apply: async (_message, result) => {
          effects.push(result);
          effectAttempts += 1;
          if (effectAttempts === 1) throw new Error("transient effect failure");
        },
      },
      now: () => new Date("2026-07-18T01:00:00.000Z"),
    });

    try {
      await dispatcher.flushOnce();
      expect(sends).toEqual(["control-card"]);
      expect(outbox.message("control-card")).toMatchObject({
        status: "delivered",
        result: { messageId: "message-created" },
      });

      await dispatcher.flushOnce(new Date("2099-01-01T00:00:00.000Z"));
      expect(sends).toEqual(["control-card"]);
      expect(effects).toEqual([
        { messageId: "message-created" },
        { messageId: "message-created" },
      ]);
      expect(outbox.message("control-card")?.status).toBe("sent");
    } finally {
      await dispatcher.stop();
      outbox.close();
    }
  });

  it("builds the Feishu card patch request without a receive ID or uuid", () => {
    expect(feishuPatchData({
      id: "update-card",
      appRole: "hub",
      receiveId: "chat-1",
      payload: { schema: "2.0", state: "active" },
      attempts: 0,
      nextAttemptAt: "2026-07-18T01:00:00.000Z",
      status: "pending",
      idempotencyKey: "update-v1",
      operation: "update",
      targetMessageId: "message-1",
    })).toEqual({
      path: { message_id: "message-1" },
      data: { content: JSON.stringify({ schema: "2.0", state: "active" }) },
    });
  });
});
