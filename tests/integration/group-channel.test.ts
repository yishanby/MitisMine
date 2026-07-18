import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDiscussion } from "../../packages/domain/src/discussion.js";
import { createTopic } from "../../packages/domain/src/topic.js";
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
      await channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:member",
        chatId: "chat-1",
        messageId: "message-steer",
        text: "Prioritize migration cost",
        sourceAppRole: "claude",
        preferredProvider: "claude",
        idempotencyKey: "claude-steer-replay",
      });
      expect(discussions.pendingSteers(active?.id ?? "")).toEqual([
        expect.objectContaining({
          messageId: "message-steer",
          text: "Prioritize migration cost",
          preferredProvider: "claude",
          status: "pending",
        }),
      ]);
      expect(events.events(topicId ?? "").map((event) => event.type)).toEqual([
        "topic.created",
        "discussion.started",
        "discussion.steer.added",
      ]);
      expect(refreshed).toEqual([active?.id, active?.id, active?.id, active?.id]);
      expect(kicked).toEqual([active?.id, active?.id, active?.id, active?.id]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each([
    "topic-created",
    "topic-bound",
    "discussion-created",
    "started-event",
    "initial-receipt",
    "initial-consumed",
  ] as const)("finishes the original start after a crash at %s", async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-start-replay-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const topic = createTopic("Choose the architecture", "tenant-1:user:owner", {
      id: "topic-from-start-message",
    });
    const messageId = "message-start";
    const topicCreated = events.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
      createdAt: topic.createdAt,
      idempotencyKey: `group-message:${messageId}:topic`,
    });
    if (boundary !== "topic-created") {
      discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
    }
    if (["discussion-created", "started-event", "initial-receipt", "initial-consumed"].includes(boundary)) {
      discussions.createDiscussion({
        ...createDiscussion({
          id: "discussion-from-start-message",
          topicId: topic.id,
          tenantKey: "tenant-1",
          chatId: "chat-1",
          question: "Choose the architecture",
          starterPrincipalId: topic.ownerPrincipalId,
        }),
        startMessageId: messageId,
      });
    }
    let started = topicCreated;
    if (["started-event", "initial-receipt", "initial-consumed"].includes(boundary)) {
      started = events.append({
        topicId: topic.id,
        type: "discussion.started",
        actorPrincipalId: topic.ownerPrincipalId,
        payload: {
          discussionId: "discussion-from-start-message",
          chatId: "chat-1",
          messageId,
          question: "Choose the architecture",
        },
        idempotencyKey: `group-message:${messageId}:discussion-started`,
      });
    }
    if (boundary === "initial-receipt" || boundary === "initial-consumed") {
      discussions.recordSteer({
        id: "initial-receipt",
        discussionId: "discussion-from-start-message",
        messageId,
        topicEventSeq: started.seq,
        principalId: topic.ownerPrincipalId,
        text: "Choose the architecture",
      });
      if (boundary === "initial-consumed") {
        discussions.consumeSteers("discussion-from-start-message", ["initial-receipt"]);
      }
    }
    let generatedId = 0;
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => `retry-generated-${++generatedId}`,
    });
    const input = {
      tenantKey: "tenant-1",
      principalId: topic.ownerPrincipalId,
      chatId: "chat-1",
      messageId,
      text: "Choose the architecture",
      sourceAppRole: "hub" as const,
      idempotencyKey: "hub-start-retry",
    };

    try {
      await channel.receive(input);
      await channel.receive({
        ...input,
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-start-replay",
      });

      const active = discussions.activeForChat("tenant-1", "chat-1");
      expect(discussions.chatTopic("tenant-1", "chat-1")).toBe(topic.id);
      expect(active).toMatchObject({
        topicId: topic.id,
        startMessageId: messageId,
        preferredProvider: "codex",
      });
      if (["discussion-created", "started-event", "initial-receipt", "initial-consumed"].includes(boundary)) {
        expect(active?.id).toBe("discussion-from-start-message");
      }
      expect(discussions.pendingSteers(active?.id ?? "")).toEqual([]);
      expect(events.events(topic.id).map((event) => event.type)).toEqual([
        "topic.created",
        "discussion.started",
      ]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each(["claude", "codex", "copilot"] as const)(
    "ignores a no-active delivery from the %s provider App",
    async (sourceAppRole) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-provider-no-start-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const refreshed: string[] = [];
      const kicked: string[] = [];
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: {
          refreshControl: async (discussionId) => { refreshed.push(discussionId); },
          kick: (discussionId) => { kicked.push(discussionId); },
        },
        idFactory: () => "provider-must-not-create-an-id",
      });

      try {
        await channel.receive({
          tenantKey: "tenant-1",
          principalId: "tenant-1:user:member",
          chatId: "chat-1",
          messageId: "provider-only-message",
          text: "Provider echo must not start a Discussion",
          sourceAppRole,
          preferredProvider: sourceAppRole,
          idempotencyKey: `${sourceAppRole}-delivery`,
        });

        const inspection = new DatabaseSync(path, { readOnly: true });
        try {
          for (const table of ["topics", "group_chat_topics", "group_discussions"] as const) {
            const row = inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              count: number;
            };
            expect(Number(row.count), table).toBe(0);
          }
        } finally {
          inspection.close();
        }
        expect(refreshed).toEqual([]);
        expect(kicked).toEqual([]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it("ignores a provider replay of a terminal Discussion start receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-terminal-start-replay-"));
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
      idFactory: () => `terminal-start-${++id}`,
    });
    const start = {
      tenantKey: "tenant-1",
      principalId: "tenant-1:user:owner",
      chatId: "chat-1",
      messageId: "terminal-start-message",
      text: "Terminal start",
      sourceAppRole: "hub" as const,
      idempotencyKey: "hub-terminal-start",
    };

    try {
      await channel.receive(start);
      const active = discussions.activeForChat("tenant-1", "chat-1");
      expect(active).toBeDefined();
      discussions.saveDiscussion({
        ...active!,
        state: "stopped",
        version: active!.version + 1,
      });
      const beforeDiscussion = discussions.discussion(active!.id);
      const beforeReceipt = discussions.steerForMessage(start.messageId);
      const beforeEvents = events.events(active!.topicId);
      const beforeBinding = discussions.chatTopic(start.tenantKey, start.chatId);
      refreshed.length = 0;
      kicked.length = 0;

      await channel.receive({
        ...start,
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-terminal-start-replay",
      });

      expect(discussions.discussion(active!.id)).toEqual(beforeDiscussion);
      expect(discussions.steerForMessage(start.messageId)).toEqual(beforeReceipt);
      expect(events.events(active!.topicId)).toEqual(beforeEvents);
      expect(discussions.chatTopic(start.tenantKey, start.chatId)).toBe(beforeBinding);
      expect(refreshed).toEqual([]);
      expect(kicked).toEqual([]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it("ignores a provider replay of an old terminal steer when a newer Discussion is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-old-steer-replay-"));
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
      idFactory: () => `old-steer-${++id}`,
    });
    const base = {
      tenantKey: "tenant-1",
      principalId: "tenant-1:user:owner",
      chatId: "chat-1",
      sourceAppRole: "hub" as const,
    };

    try {
      await channel.receive({
        ...base,
        messageId: "old-start",
        text: "Old Discussion",
        idempotencyKey: "hub-old-start",
      });
      const oldDiscussion = discussions.activeForChat("tenant-1", "chat-1");
      expect(oldDiscussion).toBeDefined();
      await channel.receive({
        ...base,
        messageId: "old-steer",
        text: "Old steer",
        idempotencyKey: "hub-old-steer",
      });
      discussions.saveDiscussion({
        ...oldDiscussion!,
        state: "stopped",
        version: (discussions.discussion(oldDiscussion!.id)?.version ?? 0) + 1,
      });
      await channel.receive({
        ...base,
        messageId: "new-start",
        text: "New Discussion",
        idempotencyKey: "hub-new-start",
      });
      const newDiscussion = discussions.activeForChat("tenant-1", "chat-1");
      expect(newDiscussion?.id).not.toBe(oldDiscussion!.id);
      const beforeOld = discussions.discussion(oldDiscussion!.id);
      const beforeNew = discussions.discussion(newDiscussion!.id);
      const beforeReceipt = discussions.steerForMessage("old-steer");
      const beforeEvents = events.events(oldDiscussion!.topicId);
      const beforeBinding = discussions.chatTopic(base.tenantKey, base.chatId);
      refreshed.length = 0;
      kicked.length = 0;

      await channel.receive({
        ...base,
        messageId: "old-steer",
        text: "Old steer",
        sourceAppRole: "claude",
        preferredProvider: "claude",
        idempotencyKey: "claude-old-steer-replay",
      });

      expect(discussions.discussion(oldDiscussion!.id)).toEqual(beforeOld);
      expect(discussions.discussion(newDiscussion!.id)).toEqual(beforeNew);
      expect(discussions.steerForMessage("old-steer")).toEqual(beforeReceipt);
      expect(events.events(oldDiscussion!.topicId)).toEqual(beforeEvents);
      expect(discussions.chatTopic(base.tenantKey, base.chatId)).toBe(beforeBinding);
      expect(refreshed).toEqual([]);
      expect(kicked).toEqual([]);
    } finally {
      discussions.close();
      events.close();
    }
  });
});
