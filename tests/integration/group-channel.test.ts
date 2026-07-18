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

function groupEffectKey(
  tenantKey: string,
  chatId: string,
  messageId: string,
  operation: "topic" | "discussion-started" | "steer",
): string {
  return `group-message:${JSON.stringify([tenantKey, chatId, messageId, operation])}`;
}

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
        starterPrincipalId: "tenant-1:user:owner",
        state: "active",
      });
      expect(events.topic(topicId ?? "")?.ownerPrincipalId).toBe(active?.starterPrincipalId);
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
          principalId: "tenant-1:user:member",
          text: "Prioritize migration cost",
          preferredProvider: "claude",
          status: "pending",
        }),
      ]);
      const topicEvents = events.events(topicId ?? "");
      expect(topicEvents.map((event) => event.type)).toEqual([
        "topic.created",
        "discussion.started",
        "discussion.steer.added",
      ]);
      expect(topicEvents[0]?.payload).toMatchObject({
        schemaVersion: 2,
        principalId: "tenant-1:user:owner",
        question: "Choose the architecture",
      });
      expect(topicEvents[1]?.payload).toMatchObject({
        schemaVersion: 2,
        starterPrincipalId: "tenant-1:user:owner",
        question: "Choose the architecture",
      });
      expect(topicEvents[2]?.payload).toMatchObject({
        schemaVersion: 2,
        principalId: "tenant-1:user:member",
        text: "Prioritize migration cost",
      });
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
      payload: {
        schemaVersion: 2,
        topic,
        principalId: topic.ownerPrincipalId,
        question: "Choose the architecture",
        tenantKey: "tenant-1",
        chatId: "chat-1",
        messageId,
      },
      createdAt: topic.createdAt,
      idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
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
          schemaVersion: 2,
          discussionId: "discussion-from-start-message",
          starterPrincipalId: topic.ownerPrincipalId,
          tenantKey: "tenant-1",
          chatId: "chat-1",
          messageId,
          question: "Choose the architecture",
        },
        idempotencyKey: groupEffectKey(
          "tenant-1",
          "chat-1",
          messageId,
          "discussion-started",
        ),
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

  it("rejects a bound group Topic owned by another tenant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-bound-topic-tenant-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const foreignTopic = createTopic("Foreign tenant Topic", "tenant-2:user:owner", {
      id: "foreign-tenant-bound-topic",
    });
    events.append({
      topicId: foreignTopic.id,
      type: "topic.created",
      payload: { topic: foreignTopic },
    });
    discussions.bindChatTopic("tenant-1", "chat-1", foreignTopic.id);
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => "must-not-create-an-id",
    });

    try {
      await expect(channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
        messageId: "foreign-tenant-bound-message",
        text: "Do not cross tenants",
        sourceAppRole: "hub",
        idempotencyKey: "hub-foreign-tenant-bound",
      })).rejects.toThrow(/group Topic tenant/i);
      expect(discussions.activeForChat("tenant-1", "chat-1")).toBeUndefined();
      expect(events.events(foreignTopic.id).map(({ type }) => type)).toEqual(["topic.created"]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it("reuses a legacy started event when its initial receipt already exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-start-receipt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const topic = createTopic("Legacy receipt", "tenant-1:user:owner", {
      id: "legacy-receipt-topic",
    });
    events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
    const messageId = "legacy-receipt-message";
    const discussion = discussions.createDiscussion(createDiscussion({
      id: "legacy-receipt-discussion",
      topicId: topic.id,
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Reuse the receipt boundary",
      starterPrincipalId: topic.ownerPrincipalId,
      startMessageId: messageId,
    }));
    const started = events.append({
      topicId: topic.id,
      type: "discussion.started",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: {
        discussionId: discussion.id,
        chatId: discussion.chatId,
        messageId,
        question: discussion.question,
      },
      idempotencyKey: `group-message:${messageId}:discussion-started`,
    });
    discussions.recordSteer({
      id: "legacy-initial-receipt",
      discussionId: discussion.id,
      messageId,
      topicEventSeq: started.seq,
      principalId: discussion.starterPrincipalId,
      text: discussion.question,
    });
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => "legacy-retry-id",
    });

    try {
      await channel.receive({
        tenantKey: discussion.tenantKey,
        principalId: discussion.starterPrincipalId,
        chatId: discussion.chatId,
        messageId,
        text: discussion.question,
        sourceAppRole: "hub",
        idempotencyKey: "hub-legacy-start-retry",
      });

      expect(events.events(topic.id).map(({ type }) => type)).toEqual([
        "topic.created",
        "discussion.started",
      ]);
      expect(discussions.steerForMessage(messageId)).toMatchObject({
        discussionId: discussion.id,
        topicEventSeq: started.seq,
      });
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each([
    ["tenant", "topic-created"],
    ["tenant", "topic-bound"],
    ["chat", "topic-created"],
    ["chat", "topic-bound"],
  ] as const)(
    "does not reuse a foreign %s scope at the %s boundary",
    async (wrongScope, boundary) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-topic-scope-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const foreignTopic = createTopic("Foreign Topic", "tenant-1:user:owner", {
        id: "foreign-topic",
      });
      const messageId = "shared-earliest-message";
      events.append({
        topicId: foreignTopic.id,
        type: "topic.created",
        actorPrincipalId: foreignTopic.ownerPrincipalId,
        payload: { topic: foreignTopic },
        idempotencyKey: `group-message:${messageId}:topic`,
      });
      if (boundary === "topic-bound") {
        discussions.bindChatTopic("tenant-1", "chat-1", foreignTopic.id);
      }
      const target = wrongScope === "tenant"
        ? {
            tenantKey: "tenant-2",
            principalId: "tenant-2:user:owner",
            chatId: "chat-1",
          }
        : {
            tenantKey: "tenant-1",
            principalId: "tenant-1:user:owner",
            chatId: "chat-2",
          };
      let id = 0;
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => `target-${wrongScope}-${boundary}-${++id}`,
      });

      try {
        await channel.receive({
          ...target,
          messageId,
          text: "Target Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `target-${wrongScope}-${boundary}`,
        });

        const targetTopicId = discussions.chatTopic(target.tenantKey, target.chatId);
        const targetDiscussion = discussions.activeForChat(target.tenantKey, target.chatId);
        expect(targetTopicId).toBeDefined();
        expect(targetTopicId).not.toBe(foreignTopic.id);
        expect(events.topic(targetTopicId ?? "")?.tenantKey).toBe(target.tenantKey);
        expect(targetDiscussion?.topicId).toBe(targetTopicId);
        expect(events.events(foreignTopic.id).map(({ type }) => type)).toEqual(["topic.created"]);
        expect(events.events(targetTopicId ?? "").map(({ type }) => type)).toEqual([
          "topic.created",
          "discussion.started",
        ]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it("reuses one scoped topic effect for the same tenant/chat across Apps", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-topic-dedup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const topic = createTopic("Scoped Topic", "tenant-1:user:owner", { id: "scoped-topic" });
    const messageId = "scoped-topic-message";
    events.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: {
        schemaVersion: 2,
        topic,
        principalId: topic.ownerPrincipalId,
        question: topic.title,
        tenantKey: "tenant-1",
        chatId: "chat-1",
        messageId,
      },
      idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
    });
    let id = 0;
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => `scoped-topic-generated-${++id}`,
    });

    try {
      await channel.receive({
        tenantKey: "tenant-1",
        principalId: topic.ownerPrincipalId,
        chatId: "chat-1",
        messageId,
        text: "Scoped Topic",
        sourceAppRole: "hub",
        idempotencyKey: "hub-scoped-topic",
      });
      await channel.receive({
        tenantKey: "tenant-1",
        principalId: topic.ownerPrincipalId,
        chatId: "chat-1",
        messageId,
        text: "Scoped Topic",
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-scoped-topic",
      });

      expect(discussions.chatTopic("tenant-1", "chat-1")).toBe(topic.id);
      expect(discussions.activeForChat("tenant-1", "chat-1")).toMatchObject({
        topicId: topic.id,
        starterPrincipalId: topic.ownerPrincipalId,
        question: "Scoped Topic",
        preferredProvider: "codex",
      });
      expect(events.topic(topic.id)?.ownerPrincipalId).toBe(topic.ownerPrincipalId);
      expect(events.events(topic.id).map(({ type }) => type)).toEqual([
        "topic.created",
        "discussion.started",
      ]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it("recovers an exact legacy scoped topic effect once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-topic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const principalId = "tenant-1:user:owner";
    const question = "Legacy scoped Topic";
    const topic = createTopic(question, principalId, { id: "legacy-scoped-topic" });
    const messageId = "legacy-scoped-topic-message";
    events.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: principalId,
      payload: {
        topic,
        tenantKey: "tenant-1",
        chatId: "chat-1",
        messageId,
      },
      idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
    });
    let id = 0;
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => `legacy-topic-${++id}`,
    });
    const input = {
      tenantKey: "tenant-1",
      principalId,
      chatId: "chat-1",
      messageId,
      text: question,
      sourceAppRole: "hub" as const,
      idempotencyKey: "hub-legacy-scoped-topic",
    };

    try {
      await channel.receive(input);
      await channel.receive({
        ...input,
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-legacy-scoped-topic",
      });

      const discussion = discussions.activeForChat(input.tenantKey, input.chatId);
      expect(discussions.chatTopic(input.tenantKey, input.chatId)).toBe(topic.id);
      expect(discussion).toMatchObject({
        topicId: topic.id,
        starterPrincipalId: principalId,
        question,
        preferredProvider: "codex",
      });
      expect(events.topic(topic.id)?.ownerPrincipalId).toBe(principalId);
      expect(events.events(topic.id).map(({ type }) => type)).toEqual([
        "topic.created",
        "discussion.started",
      ]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each(["principal", "summary"] as const)(
    "rejects a legacy scoped topic effect with a %s mismatch",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-topic-mismatch-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:owner";
      const question = "Legacy Topic question";
      const topic = createTopic(question, principalId, { id: `legacy-topic-${mismatch}` });
      const messageId = `legacy-topic-${mismatch}-message`;
      events.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: principalId,
        payload: {
          topic,
          tenantKey: "tenant-1",
          chatId: "chat-1",
          messageId,
        },
        idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
      });
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => "must-not-bind-legacy-topic-mismatch",
      });

      try {
        await expect(channel.receive({
          tenantKey: "tenant-1",
          principalId: mismatch === "principal" ? "tenant-1:user:conflict" : principalId,
          chatId: "chat-1",
          messageId,
          text: mismatch === "summary" ? "Different Topic summary" : question,
          sourceAppRole: "hub",
          idempotencyKey: `hub-legacy-topic-${mismatch}`,
        })).rejects.toThrow(/inconsistent topic\.created event/i);
        expect(discussions.chatTopic("tenant-1", "chat-1")).toBeUndefined();
        expect(discussions.activeForChat("tenant-1", "chat-1")).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each([
    "unversioned-author-fields",
    "unversioned-principal-only",
    "unversioned-question-only",
    "version-2-missing-question",
  ] as const)(
    "rejects a malformed scoped topic payload with %s",
    async (malformation) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-topic-schema-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:owner";
      const question = "Topic schema validation";
      const topic = createTopic(question, principalId, { id: `topic-${malformation}` });
      const messageId = `topic-${malformation}-message`;
      events.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: principalId,
        payload: malformation.startsWith("unversioned-")
          ? {
              topic,
              ...(malformation === "unversioned-question-only" ? {} : { principalId }),
              ...(malformation === "unversioned-principal-only" ? {} : { question }),
              tenantKey: "tenant-1",
              chatId: "chat-1",
              messageId,
            }
          : {
              schemaVersion: 2,
              topic,
              principalId,
              tenantKey: "tenant-1",
              chatId: "chat-1",
              messageId,
            },
        idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
      });
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => "must-not-bind-malformed-topic",
      });

      try {
        await expect(channel.receive({
          tenantKey: "tenant-1",
          principalId,
          chatId: "chat-1",
          messageId,
          text: question,
          sourceAppRole: "hub",
          idempotencyKey: `hub-${malformation}`,
        })).rejects.toThrow(/inconsistent topic\.created event/i);
        expect(discussions.chatTopic("tenant-1", "chat-1")).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["principal", "question"] as const)(
    "rejects a same-scope %s conflict at the topic-created boundary",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-topic-author-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:original";
      const sharedPrefix = "Q".repeat(59);
      const question = mismatch === "question"
        ? `${sharedPrefix} original full question`
        : "Original question";
      const replayQuestion = mismatch === "question"
        ? `${sharedPrefix} conflicting full question`
        : question;
      const topic = createTopic(
        mismatch === "question" ? `${sharedPrefix}…` : question,
        principalId,
        { id: `topic-${mismatch}-conflict` },
      );
      const messageId = `topic-${mismatch}-message`;
      events.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: principalId,
        payload: {
          schemaVersion: 2,
          topic,
          principalId,
          question,
          tenantKey: "tenant-1",
          chatId: "chat-1",
          messageId,
        },
        idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
      });
      const refreshed: string[] = [];
      const kicked: string[] = [];
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: {
          refreshControl: async (discussionId) => { refreshed.push(discussionId); },
          kick: (discussionId) => { kicked.push(discussionId); },
        },
        idFactory: () => "must-not-create-conflicting-discussion",
      });

      try {
        await expect(channel.receive({
          tenantKey: "tenant-1",
          principalId: mismatch === "principal" ? "tenant-1:user:conflict" : principalId,
          chatId: "chat-1",
          messageId,
          text: replayQuestion,
          sourceAppRole: "hub",
          idempotencyKey: `hub-topic-${mismatch}-conflict`,
        })).rejects.toThrow(/inconsistent topic\.created event/i);
        expect(events.topic(topic.id)?.ownerPrincipalId).toBe(principalId);
        expect(discussions.chatTopic("tenant-1", "chat-1")).toBeUndefined();
        expect(discussions.activeForChat("tenant-1", "chat-1")).toBeUndefined();
        expect(refreshed).toEqual([]);
        expect(kicked).toEqual([]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it("rejects an inconsistent returned scoped topic event before binding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-topic-validation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const topic = createTopic("Mismatched Topic", "tenant-1:user:owner", {
      id: "mismatched-topic",
    });
    const messageId = "mismatched-topic-message";
    events.append({
      topicId: topic.id,
      type: "topic.created",
      payload: {
        topic,
        tenantKey: "tenant-1",
        chatId: "chat-other",
        messageId,
      },
      idempotencyKey: groupEffectKey("tenant-1", "chat-1", messageId, "topic"),
    });
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => "unused-validation-id",
    });

    try {
      await expect(channel.receive({
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
        messageId,
        text: "Mismatched Topic",
        sourceAppRole: "hub",
        idempotencyKey: "hub-mismatched-topic",
      })).rejects.toThrow(/inconsistent topic\.created event/i);
      expect(discussions.chatTopic("tenant-1", "chat-1")).toBeUndefined();
      expect(discussions.activeForChat("tenant-1", "chat-1")).toBeUndefined();
    } finally {
      discussions.close();
      events.close();
    }
  });

  it("rejects an inconsistent returned scoped Discussion-started event before receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-started-validation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const topic = createTopic("Started validation", "tenant-1:user:owner", {
      id: "started-validation-topic",
    });
    events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
    const messageId = "started-validation-message";
    const discussion = createDiscussion({
      id: "started-validation-discussion",
      topicId: topic.id,
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Validate started event",
      starterPrincipalId: topic.ownerPrincipalId,
      startMessageId: messageId,
    });
    discussions.createDiscussion(discussion);
    events.append({
      topicId: topic.id,
      type: "discussion.started",
      payload: {
        discussionId: "different-discussion",
        tenantKey: "tenant-1",
        chatId: "chat-1",
        messageId,
        question: discussion.question,
      },
      idempotencyKey: groupEffectKey(
        "tenant-1",
        "chat-1",
        messageId,
        "discussion-started",
      ),
    });
    const refreshed: string[] = [];
    const kicked: string[] = [];
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: {
        refreshControl: async (discussionId) => { refreshed.push(discussionId); },
        kick: (discussionId) => { kicked.push(discussionId); },
      },
      idFactory: () => "unused-started-validation-id",
    });

    try {
      await expect(channel.receive({
        tenantKey: "tenant-1",
        principalId: topic.ownerPrincipalId,
        chatId: "chat-1",
        messageId,
        text: discussion.question,
        sourceAppRole: "hub",
        idempotencyKey: "hub-started-validation",
      })).rejects.toThrow(/inconsistent discussion\.started event/i);
      expect(discussions.steerForMessage(messageId)).toBeUndefined();
      expect(refreshed).toEqual([]);
      expect(kicked).toEqual([]);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it("recovers an exact legacy scoped Discussion-started effect once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-started-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    const principalId = "tenant-1:user:owner";
    const topic = createTopic("Legacy started", principalId, { id: "legacy-started-topic" });
    events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
    const messageId = "legacy-started-message";
    const discussion = discussions.createDiscussion(createDiscussion({
      id: "legacy-started-discussion",
      topicId: topic.id,
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Legacy started question",
      starterPrincipalId: principalId,
      startMessageId: messageId,
    }));
    const started = events.append({
      topicId: topic.id,
      type: "discussion.started",
      actorPrincipalId: principalId,
      payload: {
        discussionId: discussion.id,
        tenantKey: discussion.tenantKey,
        chatId: discussion.chatId,
        messageId,
        question: discussion.question,
      },
      idempotencyKey: groupEffectKey(
        discussion.tenantKey,
        discussion.chatId,
        messageId,
        "discussion-started",
      ),
    });
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => "legacy-started-receipt",
    });
    const input = {
      tenantKey: discussion.tenantKey,
      principalId,
      chatId: discussion.chatId,
      messageId,
      text: discussion.question,
      sourceAppRole: "hub" as const,
      idempotencyKey: "hub-legacy-started",
    };

    try {
      await channel.receive(input);
      await channel.receive({
        ...input,
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-legacy-started",
      });

      expect(events.events(topic.id).filter(({ type }) => type === "discussion.started"))
        .toEqual([started]);
      expect(discussions.steerForMessage(messageId)).toMatchObject({
        discussionId: discussion.id,
        topicEventSeq: started.seq,
        principalId,
        text: discussion.question,
        preferredProvider: "codex",
      });
      expect(discussions.discussion(discussion.id)?.starterPrincipalId).toBe(principalId);
      expect(events.topic(topic.id)?.ownerPrincipalId).toBe(principalId);
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each(["principal", "question"] as const)(
    "rejects a legacy scoped Discussion-started effect with a %s mismatch",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-started-mismatch-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:owner";
      const topic = createTopic("Legacy started mismatch", principalId, {
        id: `legacy-started-${mismatch}-topic`,
      });
      events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
      discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
      const messageId = `legacy-started-${mismatch}-message`;
      const discussion = discussions.createDiscussion(createDiscussion({
        id: `legacy-started-${mismatch}-discussion`,
        topicId: topic.id,
        tenantKey: "tenant-1",
        chatId: "chat-1",
        question: "Legacy started mismatch question",
        starterPrincipalId: principalId,
        startMessageId: messageId,
      }));
      events.append({
        topicId: topic.id,
        type: "discussion.started",
        actorPrincipalId: mismatch === "principal" ? "tenant-1:user:conflict" : principalId,
        payload: {
          discussionId: discussion.id,
          tenantKey: discussion.tenantKey,
          chatId: discussion.chatId,
          messageId,
          question: mismatch === "question" ? "Conflicting legacy question" : discussion.question,
        },
        idempotencyKey: groupEffectKey(
          discussion.tenantKey,
          discussion.chatId,
          messageId,
          "discussion-started",
        ),
      });
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => "must-not-record-legacy-started-mismatch",
      });

      try {
        await expect(channel.receive({
          tenantKey: discussion.tenantKey,
          principalId,
          chatId: discussion.chatId,
          messageId,
          text: discussion.question,
          sourceAppRole: "hub",
          idempotencyKey: `hub-legacy-started-${mismatch}`,
        })).rejects.toThrow(/inconsistent discussion\.started event/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["unversioned-starter", "version-2-missing-starter"] as const)(
    "rejects a malformed scoped Discussion-started payload with %s",
    async (malformation) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-started-schema-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:owner";
      const topic = createTopic("Started schema", principalId, {
        id: `started-${malformation}-topic`,
      });
      events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
      discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
      const messageId = `started-${malformation}-message`;
      const discussion = discussions.createDiscussion(createDiscussion({
        id: `started-${malformation}-discussion`,
        topicId: topic.id,
        tenantKey: "tenant-1",
        chatId: "chat-1",
        question: "Started schema question",
        starterPrincipalId: principalId,
        startMessageId: messageId,
      }));
      events.append({
        topicId: topic.id,
        type: "discussion.started",
        actorPrincipalId: principalId,
        payload: {
          ...(malformation === "version-2-missing-starter" ? { schemaVersion: 2 } : {}),
          discussionId: discussion.id,
          ...(malformation === "unversioned-starter" ? { starterPrincipalId: principalId } : {}),
          tenantKey: discussion.tenantKey,
          chatId: discussion.chatId,
          messageId,
          question: discussion.question,
        },
        idempotencyKey: groupEffectKey(
          discussion.tenantKey,
          discussion.chatId,
          messageId,
          "discussion-started",
        ),
      });
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => "must-not-record-malformed-started",
      });

      try {
        await expect(channel.receive({
          tenantKey: discussion.tenantKey,
          principalId,
          chatId: discussion.chatId,
          messageId,
          text: discussion.question,
          sourceAppRole: "hub",
          idempotencyKey: `hub-started-${malformation}`,
        })).rejects.toThrow(/inconsistent discussion\.started event/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["principal", "question"] as const)(
    "rejects a same-scope %s conflict at the Discussion-started-before-receipt boundary",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-started-author-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      const principalId = "tenant-1:user:original";
      const topic = createTopic("Started author", principalId, {
        id: `started-${mismatch}-topic`,
      });
      events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
      discussions.bindChatTopic("tenant-1", "chat-1", topic.id);
      const messageId = `started-${mismatch}-message`;
      const discussion = discussions.createDiscussion(createDiscussion({
        id: `started-${mismatch}-discussion`,
        topicId: topic.id,
        tenantKey: "tenant-1",
        chatId: "chat-1",
        question: "Original started question",
        starterPrincipalId: principalId,
        startMessageId: messageId,
      }));
      const eventPrincipalId = mismatch === "principal"
        ? "tenant-1:user:conflict"
        : principalId;
      events.append({
        topicId: topic.id,
        type: "discussion.started",
        actorPrincipalId: eventPrincipalId,
        payload: {
          schemaVersion: 2,
          discussionId: discussion.id,
          starterPrincipalId: eventPrincipalId,
          tenantKey: discussion.tenantKey,
          chatId: discussion.chatId,
          messageId,
          question: discussion.question,
        },
        idempotencyKey: groupEffectKey(
          discussion.tenantKey,
          discussion.chatId,
          messageId,
          "discussion-started",
        ),
      });
      const refreshed: string[] = [];
      const kicked: string[] = [];
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: {
          refreshControl: async (discussionId) => { refreshed.push(discussionId); },
          kick: (discussionId) => { kicked.push(discussionId); },
        },
        idFactory: () => "must-not-record-started-conflict",
      });

      try {
        await expect(channel.receive({
          tenantKey: discussion.tenantKey,
          principalId,
          chatId: discussion.chatId,
          messageId,
          text: mismatch === "question" ? "Conflicting started question" : discussion.question,
          sourceAppRole: "hub",
          idempotencyKey: `hub-started-${mismatch}-conflict`,
        })).rejects.toThrow(/inconsistent discussion(?:\.started| start replay)/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
        expect(discussions.discussion(discussion.id)?.starterPrincipalId).toBe(principalId);
        expect(events.topic(topic.id)?.ownerPrincipalId).toBe(principalId);
        expect(refreshed).toEqual([]);
        expect(kicked).toEqual([]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["tenant", "chat"] as const)(
    "does not reuse a foreign %s steer effect before its receipt",
    async (wrongScope) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-steer-scope-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      let id = 0;
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => `steer-scope-${++id}`,
      });
      const foreign = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };
      const target = wrongScope === "tenant"
        ? {
            tenantKey: "tenant-2",
            principalId: "tenant-2:user:owner",
            chatId: "chat-1",
          }
        : {
            tenantKey: "tenant-1",
            principalId: "tenant-1:user:owner",
            chatId: "chat-2",
          };

      try {
        await channel.receive({
          ...foreign,
          messageId: "foreign-steer-start",
          text: "Foreign Discussion",
          sourceAppRole: "hub",
          idempotencyKey: "hub-foreign-steer-start",
        });
        await channel.receive({
          ...target,
          messageId: `target-${wrongScope}-steer-start`,
          text: "Target Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `hub-target-${wrongScope}-steer-start`,
        });
        const foreignDiscussion = discussions.activeForChat(foreign.tenantKey, foreign.chatId);
        const targetDiscussion = discussions.activeForChat(target.tenantKey, target.chatId);
        expect(foreignDiscussion).toBeDefined();
        expect(targetDiscussion).toBeDefined();
        const messageId = "shared-steer-before-receipt";
        events.append({
          topicId: foreignDiscussion!.topicId,
          type: "discussion.steer.added",
          payload: {
            discussionId: foreignDiscussion!.id,
            messageId,
            text: "Shared steer",
          },
          idempotencyKey: `group-message:${messageId}:steer`,
        });

        await channel.receive({
          ...target,
          messageId,
          text: "Shared steer",
          sourceAppRole: "hub",
          idempotencyKey: `hub-target-${wrongScope}-steer`,
        });

        const targetEvents = events.events(targetDiscussion!.topicId)
          .filter(({ type }) => type === "discussion.steer.added");
        expect(targetEvents).toHaveLength(1);
        expect(targetEvents[0]).toMatchObject({
          topicId: targetDiscussion!.topicId,
          payload: expect.objectContaining({
            discussionId: targetDiscussion!.id,
            messageId,
          }),
        });
        expect(discussions.steerForMessage(messageId)).toMatchObject({
          discussionId: targetDiscussion!.id,
          topicEventSeq: targetEvents[0]?.seq,
        });
        expect(events.events(foreignDiscussion!.topicId)
          .filter(({ type }) => type === "discussion.steer.added")).toHaveLength(1);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it("deduplicates a same-scope cross-App steer event committed before its receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-steer-dedup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    let id = 0;
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: { refreshControl: async () => {}, kick: () => {} },
      idFactory: () => `steer-dedup-${++id}`,
    });
    const scope = {
      tenantKey: "tenant-1",
      principalId: "tenant-1:user:owner",
      chatId: "chat-1",
    };

    try {
      await channel.receive({
        ...scope,
        messageId: "steer-dedup-start",
        text: "Steer dedup Discussion",
        sourceAppRole: "hub",
        idempotencyKey: "hub-steer-dedup-start",
      });
      const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
      expect(discussion).toBeDefined();
      const messageId = "steer-dedup-message";
      const committed = events.append({
        topicId: discussion!.topicId,
        type: "discussion.steer.added",
        actorPrincipalId: scope.principalId,
        payload: {
          schemaVersion: 2,
          discussionId: discussion!.id,
          principalId: scope.principalId,
          tenantKey: scope.tenantKey,
          chatId: scope.chatId,
          messageId,
          text: "Deduplicate this steer",
        },
        idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
      });

      await channel.receive({
        ...scope,
        messageId,
        text: "Deduplicate this steer",
        sourceAppRole: "codex",
        preferredProvider: "codex",
        idempotencyKey: "codex-steer-dedup",
      });

      expect(events.events(discussion!.topicId)
        .filter(({ type }) => type === "discussion.steer.added")).toEqual([committed]);
      expect(discussions.steerForMessage(messageId)).toMatchObject({
        discussionId: discussion!.id,
        topicEventSeq: committed.seq,
        preferredProvider: "codex",
      });
    } finally {
      discussions.close();
      events.close();
    }
  });

  it.each(["active", "paused"] as const)(
    "recovers an exact legacy scoped steer effect once while %s",
    async (state) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-steer-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      let id = 0;
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => `legacy-steer-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };

      try {
        await channel.receive({
          ...scope,
          messageId: `legacy-steer-${state}-start`,
          text: "Legacy steer Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `hub-legacy-steer-${state}-start`,
        });
        const active = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(active).toBeDefined();
        const discussion = state === "paused"
          ? discussions.saveDiscussion({ ...active!, state, version: active!.version + 1 })
          : active!;
        const principalId = "tenant-1:user:member";
        const messageId = `legacy-steer-${state}-message`;
        const text = "Legacy scoped steer";
        const committed = events.append({
          topicId: discussion.topicId,
          type: "discussion.steer.added",
          actorPrincipalId: principalId,
          payload: {
            discussionId: discussion.id,
            tenantKey: scope.tenantKey,
            chatId: scope.chatId,
            messageId,
            text,
          },
          idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
        });
        const input = {
          tenantKey: scope.tenantKey,
          principalId,
          chatId: scope.chatId,
          messageId,
          text,
          sourceAppRole: "hub" as const,
          idempotencyKey: `hub-legacy-steer-${state}`,
        };

        await channel.receive(input);
        const firstReceipt = discussions.steerForMessage(messageId);
        await channel.receive({
          ...input,
          sourceAppRole: "codex",
          preferredProvider: "codex",
          idempotencyKey: `codex-legacy-steer-${state}`,
        });

        expect(events.events(discussion.topicId)
          .filter(({ type }) => type === "discussion.steer.added")).toEqual([committed]);
        expect(discussions.steerForMessage(messageId)).toMatchObject({
          id: firstReceipt?.id,
          discussionId: discussion.id,
          topicEventSeq: committed.seq,
          principalId,
          text,
          preferredProvider: "codex",
          status: "pending",
        });
        expect(discussions.pendingSteers(discussion.id)
          .filter((steer) => steer.messageId === messageId)).toHaveLength(1);
        expect(discussions.discussion(discussion.id)?.state).toBe(state);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["principal", "text"] as const)(
    "rejects a legacy scoped steer effect with a %s mismatch",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-legacy-steer-mismatch-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      let id = 0;
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => `legacy-steer-mismatch-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };

      try {
        await channel.receive({
          ...scope,
          messageId: `legacy-steer-${mismatch}-start`,
          text: "Legacy steer mismatch Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `hub-legacy-steer-${mismatch}-start`,
        });
        const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(discussion).toBeDefined();
        const principalId = "tenant-1:user:member";
        const messageId = `legacy-steer-${mismatch}-message`;
        const text = "Legacy steer mismatch";
        events.append({
          topicId: discussion!.topicId,
          type: "discussion.steer.added",
          actorPrincipalId: mismatch === "principal" ? "tenant-1:user:conflict" : principalId,
          payload: {
            discussionId: discussion!.id,
            tenantKey: scope.tenantKey,
            chatId: scope.chatId,
            messageId,
            text: mismatch === "text" ? "Conflicting legacy steer" : text,
          },
          idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
        });

        await expect(channel.receive({
          tenantKey: scope.tenantKey,
          principalId,
          chatId: scope.chatId,
          messageId,
          text,
          sourceAppRole: "hub",
          idempotencyKey: `hub-legacy-steer-${mismatch}`,
        })).rejects.toThrow(/inconsistent discussion\.steer\.added event/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["unversioned-principal", "version-2-missing-principal"] as const)(
    "rejects a malformed scoped steer payload with %s",
    async (malformation) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-steer-schema-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "group.db");
      const events = EventStore.open(path);
      const discussions = SqliteDiscussionStore.open(path);
      let id = 0;
      const channel = new GroupDiscussionChannel({
        store: discussions,
        events,
        coordinator: { refreshControl: async () => {}, kick: () => {} },
        idFactory: () => `steer-schema-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };

      try {
        await channel.receive({
          ...scope,
          messageId: `steer-${malformation}-start`,
          text: "Steer schema Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `hub-steer-${malformation}-start`,
        });
        const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(discussion).toBeDefined();
        const principalId = "tenant-1:user:member";
        const messageId = `steer-${malformation}-message`;
        const text = "Steer schema validation";
        events.append({
          topicId: discussion!.topicId,
          type: "discussion.steer.added",
          actorPrincipalId: principalId,
          payload: {
            ...(malformation === "version-2-missing-principal" ? { schemaVersion: 2 } : {}),
            discussionId: discussion!.id,
            ...(malformation === "unversioned-principal" ? { principalId } : {}),
            tenantKey: scope.tenantKey,
            chatId: scope.chatId,
            messageId,
            text,
          },
          idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
        });

        await expect(channel.receive({
          tenantKey: scope.tenantKey,
          principalId,
          chatId: scope.chatId,
          messageId,
          text,
          sourceAppRole: "hub",
          idempotencyKey: `hub-steer-${malformation}`,
        })).rejects.toThrow(/inconsistent discussion\.steer\.added event/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each(["principal", "text"] as const)(
    "rejects a same-scope %s conflict at the steer-event-before-receipt boundary",
    async (mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-steer-author-"));
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
        idFactory: () => `steer-author-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };

      try {
        await channel.receive({
          ...scope,
          messageId: `steer-${mismatch}-start`,
          text: "Steer author Discussion",
          sourceAppRole: "hub",
          idempotencyKey: `hub-steer-${mismatch}-start`,
        });
        const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(discussion).toBeDefined();
        const principalId = "tenant-1:user:member";
        const messageId = `steer-${mismatch}-message`;
        const text = "Original steer text";
        events.append({
          topicId: discussion!.topicId,
          type: "discussion.steer.added",
          actorPrincipalId: principalId,
          payload: {
            schemaVersion: 2,
            discussionId: discussion!.id,
            principalId,
            tenantKey: scope.tenantKey,
            chatId: scope.chatId,
            messageId,
            text,
          },
          idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
        });
        refreshed.length = 0;
        kicked.length = 0;

        await expect(channel.receive({
          tenantKey: scope.tenantKey,
          principalId: mismatch === "principal" ? "tenant-1:user:conflict" : principalId,
          chatId: scope.chatId,
          messageId,
          text: mismatch === "text" ? "Conflicting steer text" : text,
          sourceAppRole: "hub",
          idempotencyKey: `hub-steer-${mismatch}-conflict`,
        })).rejects.toThrow(/inconsistent discussion\.steer\.added event/i);
        expect(discussions.steerForMessage(messageId)).toBeUndefined();
        expect(discussions.discussion(discussion!.id)?.starterPrincipalId)
          .toBe(scope.principalId);
        expect(events.topic(discussion!.topicId)?.ownerPrincipalId).toBe(scope.principalId);
        expect(events.events(discussion!.topicId)
          .filter(({ type }) => type === "discussion.steer.added")).toHaveLength(1);
        expect(refreshed).toEqual([]);
        expect(kicked).toEqual([]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it.each([
    ["paused", "delivery"],
    ["paused", "event-before-receipt"],
    ["summarizing", "delivery"],
    ["summarizing", "event-before-receipt"],
  ] as const)(
    "records one scoped steer while %s across the %s boundary and App retry",
    async (state, boundary) => {
      const directory = mkdtempSync(join(tmpdir(), `mitismine-group-${state}-steer-`));
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
        idFactory: () => `${state}-steer-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };

      try {
        await channel.receive({
          ...scope,
          messageId: `${state}-steer-start`,
          text: `${state} steer Discussion`,
          sourceAppRole: "hub",
          idempotencyKey: `hub-${state}-steer-start`,
        });
        const active = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(active).toBeDefined();
        const discussion = discussions.saveDiscussion({
          ...active!,
          state,
          version: active!.version + 1,
        });
        refreshed.length = 0;
        kicked.length = 0;
        const messageId = `${state}-${boundary}-steer-message`;
        const text = `Steer while ${state}`;
        if (boundary === "event-before-receipt") {
          events.append({
            topicId: discussion.topicId,
            type: "discussion.steer.added",
            actorPrincipalId: scope.principalId,
            payload: {
              schemaVersion: 2,
              discussionId: discussion.id,
              principalId: scope.principalId,
              tenantKey: scope.tenantKey,
              chatId: scope.chatId,
              messageId,
              text,
            },
            idempotencyKey: groupEffectKey(
              scope.tenantKey,
              scope.chatId,
              messageId,
              "steer",
            ),
          });
        }

        await channel.receive({
          ...scope,
          messageId,
          text,
          sourceAppRole: "hub",
          idempotencyKey: `hub-${state}-${boundary}-steer`,
        });
        const firstReceipt = discussions.steerForMessage(messageId);
        expect(firstReceipt).toMatchObject({
          discussionId: discussion.id,
          messageId,
          text,
          status: "pending",
        });

        await channel.receive({
          ...scope,
          messageId,
          text,
          sourceAppRole: "codex",
          preferredProvider: "codex",
          idempotencyKey: `codex-${state}-${boundary}-steer`,
        });

        const steerEvents = events.events(discussion.topicId)
          .filter(({ type }) => type === "discussion.steer.added");
        expect(steerEvents).toHaveLength(1);
        expect(steerEvents[0]).toMatchObject({
          topicId: discussion.topicId,
          payload: {
            discussionId: discussion.id,
            tenantKey: scope.tenantKey,
            chatId: scope.chatId,
            messageId,
            text,
          },
        });
        expect(discussions.steerForMessage(messageId)).toMatchObject({
          id: firstReceipt?.id,
          discussionId: discussion.id,
          topicEventSeq: steerEvents[0]?.seq,
          preferredProvider: "codex",
          status: "pending",
        });
        expect(discussions.pendingSteers(discussion.id)
          .filter((steer) => steer.messageId === messageId)).toHaveLength(1);
        expect(discussions.discussion(discussion.id)?.state).toBe(state);
        expect(refreshed).toEqual([discussion.id, discussion.id]);
        expect(kicked).toEqual([discussion.id, discussion.id]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );

  it("rejects an inconsistent returned scoped steer event before recording receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-group-steer-validation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "group.db");
    const events = EventStore.open(path);
    const discussions = SqliteDiscussionStore.open(path);
    let id = 0;
    const refreshed: string[] = [];
    const kicked: string[] = [];
    const channel = new GroupDiscussionChannel({
      store: discussions,
      events,
      coordinator: {
        refreshControl: async (discussionId) => { refreshed.push(discussionId); },
        kick: (discussionId) => { kicked.push(discussionId); },
      },
      idFactory: () => `steer-validation-${++id}`,
    });
    const scope = {
      tenantKey: "tenant-1",
      principalId: "tenant-1:user:owner",
      chatId: "chat-1",
    };

    try {
      await channel.receive({
        ...scope,
        messageId: "steer-validation-start",
        text: "Steer validation Discussion",
        sourceAppRole: "hub",
        idempotencyKey: "hub-steer-validation-start",
      });
      const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
      expect(discussion).toBeDefined();
      const messageId = "steer-validation-message";
      events.append({
        topicId: discussion!.topicId,
        type: "discussion.steer.added",
        payload: {
          discussionId: "different-discussion",
          tenantKey: scope.tenantKey,
          chatId: scope.chatId,
          messageId,
          text: "Validate steer",
        },
        idempotencyKey: groupEffectKey(scope.tenantKey, scope.chatId, messageId, "steer"),
      });
      refreshed.length = 0;
      kicked.length = 0;

      await expect(channel.receive({
        ...scope,
        messageId,
        text: "Validate steer",
        sourceAppRole: "hub",
        idempotencyKey: "hub-steer-validation",
      })).rejects.toThrow(/inconsistent discussion\.steer\.added event/i);
      expect(discussions.steerForMessage(messageId)).toBeUndefined();
      expect(refreshed).toEqual([]);
      expect(kicked).toEqual([]);
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

  it.each([
    ["start", "principal"],
    ["start", "text"],
    ["steer", "principal"],
    ["steer", "text"],
  ] as const)(
    "rejects a same-scope persisted %s receipt replay with conflicting %s",
    async (receiptKind, mismatch) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-group-receipt-author-"));
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
        idFactory: () => `receipt-author-${++id}`,
      });
      const scope = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
      };
      const start = {
        ...scope,
        messageId: `receipt-author-${receiptKind}-start`,
        text: "Receipt author Discussion",
        sourceAppRole: "hub" as const,
        idempotencyKey: `hub-receipt-author-${receiptKind}-start`,
      };

      try {
        await channel.receive(start);
        const discussion = discussions.activeForChat(scope.tenantKey, scope.chatId);
        expect(discussion).toBeDefined();
        const original = receiptKind === "start"
          ? start
          : {
              ...scope,
              principalId: "tenant-1:user:member",
              messageId: "receipt-author-steer-message",
              text: "Original receipt steer",
              sourceAppRole: "hub" as const,
              idempotencyKey: "hub-receipt-author-steer",
            };
        if (receiptKind === "steer") await channel.receive(original);
        const beforeDiscussion = discussions.discussion(discussion!.id);
        const beforeReceipt = discussions.steerForMessage(original.messageId);
        const beforeEvents = events.events(discussion!.topicId);
        refreshed.length = 0;
        kicked.length = 0;

        await expect(channel.receive({
          ...original,
          principalId: mismatch === "principal"
            ? "tenant-1:user:conflict"
            : original.principalId,
          text: mismatch === "text" ? "Conflicting replay text" : original.text,
          sourceAppRole: "codex",
          preferredProvider: "codex",
          idempotencyKey: `codex-${receiptKind}-${mismatch}-conflict`,
        })).rejects.toThrow(new RegExp(`inconsistent Discussion ${receiptKind} replay`, "i"));
        expect(discussions.discussion(discussion!.id)).toEqual(beforeDiscussion);
        expect(discussions.steerForMessage(original.messageId)).toEqual(beforeReceipt);
        expect(events.events(discussion!.topicId)).toEqual(beforeEvents);
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

  it.each([
    ["start", "hub", "tenant"],
    ["start", "hub", "chat"],
    ["start", "codex", "tenant"],
    ["start", "codex", "chat"],
    ["steer", "hub", "tenant"],
    ["steer", "hub", "chat"],
    ["steer", "codex", "tenant"],
    ["steer", "codex", "chat"],
  ] as const)(
    "ignores a %s receipt collision from the %s App in the wrong %s",
    async (receiptKind, sourceAppRole, wrongScope) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-scoped-receipt-"));
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
        idFactory: () => `scoped-receipt-${++id}`,
      });
      const base = {
        tenantKey: "tenant-1",
        principalId: "tenant-1:user:owner",
        chatId: "chat-1",
        sourceAppRole: "hub" as const,
      };
      const start = {
        ...base,
        messageId: "scoped-start",
        text: "Scoped start",
        idempotencyKey: "hub-scoped-start",
      };

      try {
        await channel.receive(start);
        if (receiptKind === "steer") {
          await channel.receive({
            ...base,
            messageId: "scoped-steer",
            text: "Scoped steer",
            idempotencyKey: "hub-scoped-steer",
          });
        }
        const discussion = discussions.activeForChat(base.tenantKey, base.chatId);
        expect(discussion).toBeDefined();
        const messageId = receiptKind === "start" ? start.messageId : "scoped-steer";
        const beforeDiscussion = discussions.discussion(discussion!.id);
        const beforeReceipt = discussions.steerForMessage(messageId);
        const beforeEvents = events.events(discussion!.topicId);
        const beforePending = discussions.pendingSteers(discussion!.id);
        const beforeBinding = discussions.chatTopic(base.tenantKey, base.chatId);
        refreshed.length = 0;
        kicked.length = 0;
        const tenantKey = wrongScope === "tenant" ? "tenant-2" : base.tenantKey;
        const chatId = wrongScope === "chat" ? "chat-2" : base.chatId;

        await channel.receive({
          tenantKey,
          principalId: wrongScope === "tenant"
            ? "tenant-2:user:intruder"
            : base.principalId,
          chatId,
          messageId,
          text: receiptKind === "start" ? start.text : "Scoped steer",
          sourceAppRole,
          preferredProvider: "codex",
          idempotencyKey: `${sourceAppRole}-${wrongScope}-${receiptKind}-collision`,
        });

        expect(discussions.discussion(discussion!.id)).toEqual(beforeDiscussion);
        expect(discussions.steerForMessage(messageId)).toEqual(beforeReceipt);
        expect(discussions.pendingSteers(discussion!.id)).toEqual(beforePending);
        expect(events.events(discussion!.topicId)).toEqual(beforeEvents);
        expect(discussions.chatTopic(base.tenantKey, base.chatId)).toBe(beforeBinding);
        expect(discussions.chatTopic(tenantKey, chatId)).toBe(
          tenantKey === base.tenantKey && chatId === base.chatId ? beforeBinding : undefined,
        );
        expect(refreshed).toEqual([]);
        expect(kicked).toEqual([]);
      } finally {
        discussions.close();
        events.close();
      }
    },
  );
});
