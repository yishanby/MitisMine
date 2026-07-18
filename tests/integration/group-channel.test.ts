import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GroupDiscussionChannel } from "../../packages/orchestrator/src/discussion.js";
import { SqliteDiscussionStore } from "../../packages/storage/src/discussion.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GroupDiscussionChannel", () => {
  it("creates one group Topic/Discussion and turns later messages into steer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-channel-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const refreshed: string[] = [];
    const kicked: string[] = [];
    let id = 0;
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: {
        refreshControl: async (discussionId) => { refreshed.push(discussionId); },
        kick: (discussionId) => { kicked.push(discussionId); },
      },
      idFactory: () => `generated-${++id}`,
    });

    try {
      await channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
        messageId: "message-start",
        text: "Choose the architecture",
        sourceAppRole: "hub",
        idempotencyKey: "hub-start",
      });
      const topicId = discussions.chatTopic("tenant-1", "chat-1");
      const active = discussions.activeForChat("tenant-1", "chat-1");
      expect(topicId).toBe("generated-1");
      expect(active).toMatchObject({
        id: "generated-2",
        topicId,
        question: "Choose the architecture",
        state: "active",
      });
      expect(discussions.pendingSteers(active?.id ?? "")).toEqual([]);

      await channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
        messageId: "message-start",
        text: "Choose the architecture",
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-duplicate-start",
      });
      expect(discussions.pendingSteers(active?.id ?? "")).toEqual([]);
      expect(discussions.discussion(active?.id ?? "")?.preferredProvider).toBe("codex");

      await channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:member",
        chatId: "chat-1",
        messageId: "message-steer",
        text: "Prioritize migration cost",
        sourceAppRole: "hub",
        idempotencyKey: "hub-steer",
      });
      expect(discussions.pendingSteers(active?.id ?? "")).toEqual([
        expect.objectContaining({
          messageId: "message-steer",
          text: "Prioritize migration cost",
          status: "pending",
        }),
      ]);
      expect(events.events(topicId ?? "").map((event) => event.type)).toEqual([
        "topic.created",
        "discussion.started",
        "discussion.steer.added",
      ]);
      expect(refreshed).toEqual([active?.id, active?.id, active?.id]);
      expect(kicked).toEqual([active?.id, active?.id, active?.id]);
    } finally {
      discussions.close();
      events.close();
    }
  });
});
