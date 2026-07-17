import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCommand } from "../../packages/feishu/src/commands.js";
import {
  FeishuGateway,
  type DispatchInput,
  type FeishuMessageEvent,
} from "../../packages/feishu/src/gateway.js";
import { verifyCrossAppIdentity } from "../../packages/feishu/src/registry.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-feishu-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "test.db") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function message(
  appRole: FeishuMessageEvent["appRole"],
  text: string,
  eventId = `${appRole}-${text}`,
): FeishuMessageEvent {
  return {
    appRole,
    eventId,
    tenantKey: "tenant-1",
    userId: "user-1",
    unionId: "union-1",
    openId: `${appRole}-open-id`,
    messageId: `${eventId}-message`,
    chatId: `${appRole}-chat`,
    text,
  };
}

function gatewayHarness(
  path: string,
  onDispatch: (input: DispatchInput) => Promise<void> = async () => {},
) {
  const store = EventStore.open(path);
  const outbox = DurableOutbox.open(path);
  const dispatches: DispatchInput[] = [];
  let nextId = 0;
  const gateway = new FeishuGateway({
    store,
    outbox,
    idFactory: () => `topic-${++nextId}`,
    dispatcher: {
      dispatch: async (input) => {
        dispatches.push(input);
        await onDispatch(input);
      },
    },
  });
  return { store, outbox, gateway, dispatches };
}

describe("Feishu commands", () => {
  it.each([
    ["/topic new Research", "topic.new"],
    ["/topic list", "topic.list"],
    ["/topic use 01ABC", "topic.use"],
    ["/topic show", "topic.show"],
    ["/topic share tenant:user:two editor", "topic.share"],
    ["/topic archive", "topic.archive"],
    ["/note remember this", "note"],
    ["/research investigate", "research"],
    ["/status", "status"],
    ["/stop", "stop"],
    ["/report", "report"],
    ["/action write smoke/approved.txt hello", "action.write"],
    ["ordinary question", "message"],
  ])("parses %s", (text, kind) => {
    expect(parseCommand(text).kind).toBe(kind);
  });
});

describe("FeishuGateway", () => {
  it("shares a global Topic cursor across four app-specific open_ids", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);

    await harness.gateway.receive(message("hub", "/topic new Research"));
    await harness.gateway.receive(message("claude", "continue", "event-continue"));

    expect(harness.dispatches.at(-1)).toMatchObject({
      mode: "direct",
      provider: "claude",
      topicTitle: "Research",
      question: "continue",
    });
    expect(harness.store.currentTopic("tenant-1", "tenant-1:user:user-1")).toBe("topic-1");
    harness.store.close();
    harness.outbox.close();
  });

  it("routes ordinary hub messages to full research and persists before dispatch", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "Compare the evidence", "event-research"));

    const dispatch = harness.dispatches.at(-1);
    expect(dispatch).toMatchObject({ mode: "research", question: "Compare the evidence" });
    expect(harness.store.events(dispatch?.topicId ?? "").map((event) => event.type)).toEqual([
      "topic.created",
      "message.added",
    ]);
    harness.store.close();
    harness.outbox.close();
  });

  it("routes a privileged write as an approval action without executing it", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "/topic new Approval"));
    await harness.gateway.receive(
      message("hub", "/action write smoke/approved.txt approved", "event-action"),
    );

    expect(harness.dispatches.at(-1)).toMatchObject({
      mode: "action",
      action: {
        kind: "write_file",
        target: "smoke/approved.txt",
        parameters: { content: "approved" },
      },
    });
    harness.store.close();
    harness.outbox.close();
  });

  it("resolves a Feishu @mention when sharing a Topic", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "/topic new Shared"));
    await harness.gateway.receive({
      ...message("hub", "/topic share @_user_1 editor", "event-share"),
      mentions: [{ key: "@_user_1", userId: "user-2", unionId: "union-2" }],
    });

    expect(harness.store.members("topic-1")).toContainEqual({
      principalId: "tenant-1:user:user-2",
      role: "editor",
    });
    harness.store.close();
    harness.outbox.close();
  });

  it("deduplicates events across restart and replays the durable Outbox", async () => {
    const { path } = temporaryDatabase();
    const first = gatewayHarness(path);
    const event = message("hub", "/topic new Durable", "same-event");
    expect((await first.gateway.receive(event)).duplicate).toBe(false);
    expect((await first.gateway.receive(event)).duplicate).toBe(true);
    expect(first.outbox.pending()).toHaveLength(1);
    first.store.close();
    first.outbox.close();

    const second = gatewayHarness(path);
    expect((await second.gateway.receive(event)).duplicate).toBe(true);
    expect(second.outbox.pending()).toHaveLength(1);
    second.store.close();
    second.outbox.close();
  });

  it("retries a failed dispatch and only deduplicates after success", async () => {
    const { path } = temporaryDatabase();
    let attempts = 0;
    const harness = gatewayHarness(path, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient dispatch failure");
    });
    try {
      const event = message("hub", "Retry this research", "retry-event");

      await expect(harness.gateway.receive(event)).rejects.toThrow("transient dispatch failure");
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: false });
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: true });
      expect(attempts).toBe(2);
      expect(harness.store.listTopics("tenant-1", "tenant-1:user:user-1")).toHaveLength(1);
      expect(harness.store.events("topic-1").map((stored) => stored.type)).toEqual([
        "topic.created",
        "message.added",
      ]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("replays a route after the accepted response is durably enqueued", async () => {
    const { path } = temporaryDatabase();
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    let failAfterEnqueue = true;
    let nextId = 0;
    const gateway = new FeishuGateway({
      store,
      outbox: {
        enqueue: (input) => {
          const inserted = outbox.enqueue(input);
          if (failAfterEnqueue) {
            failAfterEnqueue = false;
            throw new Error("crash after accepted outbox");
          }
          return inserted;
        },
      },
      dispatcher: { dispatch: async () => {} },
      idFactory: () => `topic-${++nextId}`,
    });
    const event = message("hub", "/topic new Durable route", "outbox-crash-event");

    try {
      await expect(gateway.receive(event)).rejects.toThrow("crash after accepted outbox");
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: false });
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: true });
      expect(store.listTopics("tenant-1", "tenant-1:user:user-1")).toHaveLength(1);
      expect(outbox.pending()).toHaveLength(1);
    } finally {
      store.close();
      outbox.close();
    }
  });

  it("reuses the deterministic dispatch key after a checkpointed failure", async () => {
    const { path } = temporaryDatabase();
    let checkpointKey: string | undefined;
    let starts = 0;
    let resumes = 0;
    const harness = gatewayHarness(path, async (input) => {
      if (checkpointKey === undefined) {
        checkpointKey = input.idempotencyKey;
        starts += 1;
        throw new Error("crash after checkpoint");
      }
      expect(input.idempotencyKey).toBe(checkpointKey);
      resumes += 1;
    });
    const event = message("hub", "Checkpointed research", "checkpoint-event");

    try {
      await expect(harness.gateway.receive(event)).rejects.toThrow("crash after checkpoint");
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: false });
      expect({ starts, resumes }).toEqual({ starts: 1, resumes: 1 });
      expect(harness.store.events("topic-1").map((stored) => stored.type)).toEqual([
        "topic.created",
        "message.added",
      ]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("does not claim an event when stable identity resolution fails", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    const corrected = message("hub", "/topic new Identity", "identity-event");
    const { userId: _userId, unionId: _unionId, ...missingIdentity } = corrected;

    try {
      await expect(harness.gateway.receive(missingIdentity)).rejects.toThrow(
        "stable Feishu identity missing",
      );
      await expect(harness.gateway.receive(corrected)).resolves.toEqual({ duplicate: false });
      expect(harness.store.topic("topic-1")?.title).toBe("Identity");
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("accepts the documented Feishu v2 fixture", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/feishu-message.json"), "utf8"),
    ) as unknown;

    await harness.gateway.receiveSdkEvent("hub", fixture);
    expect(harness.store.topic("topic-1")?.title).toBe("Fixture Research");
    harness.store.close();
    harness.outbox.close();
  });
});

describe("cross-App identity verification", () => {
  it("requires all four Apps to resolve to the same stable principal", () => {
    expect(
      verifyCrossAppIdentity([
        { appRole: "hub", tenantKey: "t", userId: "u" },
        { appRole: "claude", tenantKey: "t", userId: "u" },
        { appRole: "codex", tenantKey: "t", userId: "u" },
        { appRole: "copilot", tenantKey: "t", userId: "u" },
      ]),
    ).toBe("t:user:u");
    expect(() =>
      verifyCrossAppIdentity([
        { appRole: "hub", tenantKey: "t", userId: "u" },
        { appRole: "claude", tenantKey: "t", userId: "other" },
        { appRole: "codex", tenantKey: "t", userId: "u" },
        { appRole: "copilot", tenantKey: "t", userId: "u" },
      ]),
    ).toThrow(/identity mismatch/i);
  });
});
