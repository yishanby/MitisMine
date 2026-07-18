import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  completeDiscussionTurn,
  createDiscussion,
} from "../../packages/domain/src/discussion.js";
import { createTopic } from "../../packages/domain/src/topic.js";
import { SqliteDiscussionStore } from "../../packages/storage/src/discussion.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-discussion-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "test.db");
}

function seedTopic(path: string, id = "topic-1"): void {
  const events = EventStore.open(path);
  const topic = createTopic("Group topic", "tenant-1:user:owner", { id });
  events.append({ topicId: id, type: "topic.created", payload: { topic } });
  events.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteDiscussionStore", () => {
  it("binds a group Topic and permits only one active Discussion per chat", () => {
    const path = databasePath();
    seedTopic(path);
    const store = SqliteDiscussionStore.open(path);
    const first = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "First question",
      starterPrincipalId: "tenant-1:user:owner",
      now: "2026-07-18T01:00:00.000Z",
    });
    try {
      store.bindChatTopic("tenant-1", "chat-1", "topic-1", "2026-07-18T01:00:00.000Z");
      expect(store.chatTopic("tenant-1", "chat-1")).toBe("topic-1");
      expect(store.createDiscussion(first)).toEqual(first);
      expect(store.activeForChat("tenant-1", "chat-1")?.id).toBe(first.id);
      expect(() => store.createDiscussion({ ...first, id: "discussion-2" }))
        .toThrow(/active discussion/i);

      store.saveDiscussion({ ...first, state: "completed" });
      expect(store.activeForChat("tenant-1", "chat-1")).toBeUndefined();
      expect(store.createDiscussion({ ...first, id: "discussion-2", question: "Second" }).id)
        .toBe("discussion-2");
    } finally {
      store.close();
    }
  });

  it("deduplicates cross-App steer receipts and enriches the preferred provider", () => {
    const path = databasePath();
    seedTopic(path);
    const events = EventStore.open(path);
    const discussionStore = SqliteDiscussionStore.open(path);
    const discussion = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Question",
      starterPrincipalId: "tenant-1:user:owner",
    });
    discussionStore.createDiscussion(discussion);
    const topicEvent = events.append({
      topicId: "topic-1",
      type: "discussion.steer.added",
      actorPrincipalId: "tenant-1:user:member",
      payload: { text: "Focus on cost" },
    });
    try {
      const first = discussionStore.recordSteer({
        id: "steer-1",
        discussionId: discussion.id,
        messageId: "message-1",
        topicEventSeq: topicEvent.seq,
        principalId: "tenant-1:user:member",
        text: "Focus on cost",
        createdAt: "2026-07-18T01:00:00.000Z",
      });
      const duplicate = discussionStore.recordSteer({
        id: "steer-duplicate",
        discussionId: discussion.id,
        messageId: "message-1",
        topicEventSeq: topicEvent.seq,
        principalId: "tenant-1:user:member",
        text: "Focus on cost",
        preferredProvider: "codex",
        createdAt: "2026-07-18T01:00:01.000Z",
      });

      expect(first.inserted).toBe(true);
      expect(duplicate.inserted).toBe(false);
      expect(discussionStore.pendingSteers(discussion.id)).toEqual([
        expect.objectContaining({
          id: "steer-1",
          messageId: "message-1",
          preferredProvider: "codex",
          status: "pending",
        }),
      ]);
    } finally {
      discussionStore.close();
      events.close();
    }
  });

  it.each(["discussion", "principal", "text"] as const)(
    "rejects a duplicate message with a conflicting %s before binding or preference mutation",
    (mismatch) => {
      const path = databasePath();
      seedTopic(path);
      const events = EventStore.open(path);
      const store = SqliteDiscussionStore.open(path);
      const first = createDiscussion({
        id: "identity-discussion-1",
        topicId: "topic-1",
        tenantKey: "tenant-1",
        chatId: "identity-chat-1",
        question: "First identity",
        starterPrincipalId: "tenant-1:user:owner",
      });
      const second = createDiscussion({
        id: "identity-discussion-2",
        topicId: "topic-1",
        tenantKey: "tenant-1",
        chatId: "identity-chat-2",
        question: "Second identity",
        starterPrincipalId: "tenant-1:user:owner",
      });
      store.createDiscussion(first);
      store.createDiscussion(second);
      store.recordSteer({
        id: "identity-steer",
        discussionId: first.id,
        messageId: "identity-message",
        principalId: "tenant-1:user:member",
        text: "Immutable steer text",
        createdAt: "2026-07-18T01:00:00.000Z",
      });
      const event = events.append({
        topicId: first.topicId,
        type: "discussion.steer.added",
        actorPrincipalId: "tenant-1:user:member",
        payload: { text: "Immutable steer text" },
      });
      const beforeReceipt = store.steerForMessage("identity-message");
      const beforeFirst = store.discussion(first.id);
      const beforeSecond = store.discussion(second.id);
      try {
        expect(() => store.recordSteer({
          id: "identity-steer-duplicate",
          discussionId: mismatch === "discussion" ? second.id : first.id,
          messageId: "identity-message",
          topicEventSeq: event.seq,
          principalId: mismatch === "principal"
            ? "tenant-1:user:conflict"
            : "tenant-1:user:member",
          text: mismatch === "text" ? "Conflicting steer text" : "Immutable steer text",
          preferredProvider: "codex",
        })).toThrow(/inconsistent discussion steer receipt/i);

        expect(store.steerForMessage("identity-message")).toEqual(beforeReceipt);
        expect(store.discussion(first.id)).toEqual(beforeFirst);
        expect(store.discussion(second.id)).toEqual(beforeSecond);
      } finally {
        store.close();
        events.close();
      }
    },
  );

  it("rejects a conflicting defined provider before binding an existing receipt", () => {
    const path = databasePath();
    seedTopic(path);
    const events = EventStore.open(path);
    const store = SqliteDiscussionStore.open(path);
    const discussion = createDiscussion({
      id: "provider-identity-discussion",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "provider-identity-chat",
      question: "Provider identity",
      starterPrincipalId: "tenant-1:user:owner",
    });
    store.createDiscussion(discussion);
    store.recordSteer({
      id: "provider-identity-steer",
      discussionId: discussion.id,
      messageId: "provider-identity-message",
      principalId: "tenant-1:user:member",
      text: "Immutable provider steer",
      preferredProvider: "codex",
    });
    const event = events.append({
      topicId: discussion.topicId,
      type: "discussion.steer.added",
      actorPrincipalId: "tenant-1:user:member",
      payload: { text: "Immutable provider steer" },
    });
    const beforeReceipt = store.steerForMessage("provider-identity-message");
    const beforeDiscussion = store.discussion(discussion.id);
    try {
      expect(() => store.recordSteer({
        id: "provider-identity-duplicate",
        discussionId: discussion.id,
        messageId: "provider-identity-message",
        topicEventSeq: event.seq,
        principalId: "tenant-1:user:member",
        text: "Immutable provider steer",
        preferredProvider: "claude",
      })).toThrow(/conflicting preferred provider/i);
      expect(store.steerForMessage("provider-identity-message")).toEqual(beforeReceipt);
      expect(store.discussion(discussion.id)).toEqual(beforeDiscussion);
    } finally {
      store.close();
      events.close();
    }
  });

  it("returns only a fully correlated start-message replay", () => {
    const path = databasePath();
    seedTopic(path);
    seedTopic(path, "topic-2");
    const store = SqliteDiscussionStore.open(path);
    const first = createDiscussion({
      id: "discussion-original",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Original question",
      starterPrincipalId: "tenant-1:user:owner",
      startMessageId: "shared-start-message",
    });
    store.createDiscussion(first);
    try {
      expect(store.createDiscussion({ ...first, id: "discussion-exact-replay" })).toEqual(first);
      const collisions = [
        { ...first, id: "discussion-other-tenant", tenantKey: "tenant-2", chatId: "chat-2" },
        { ...first, id: "discussion-other-chat", chatId: "chat-2" },
        { ...first, id: "discussion-other-topic", topicId: "topic-2" },
        { ...first, id: "discussion-other-question", question: "Changed question" },
        {
          ...first,
          id: "discussion-other-starter",
          starterPrincipalId: "tenant-1:user:other",
        },
      ];
      for (const collision of collisions) {
        expect(() => store.createDiscussion(collision))
          .toThrow("Discussion start message conflicts with another Discussion");
        expect(store.discussion(collision.id)).toBeUndefined();
      }
    } finally {
      store.close();
    }
  });

  it("classifies only the exact active-chat constraint and preserves PK/FK failures", () => {
    const path = databasePath();
    seedTopic(path);
    const store = SqliteDiscussionStore.open(path);
    const first = createDiscussion({
      id: "discussion-original",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Original question",
      starterPrincipalId: "tenant-1:user:owner",
      startMessageId: "original-start",
    });
    store.createDiscussion(first);
    try {
      expect(() => store.createDiscussion({
        ...first,
        tenantKey: "tenant-2",
        chatId: "chat-2",
        startMessageId: "duplicate-id-start",
      })).toThrow("UNIQUE constraint failed: group_discussions.id");
      expect(() => store.createDiscussion({
        ...first,
        id: "discussion-missing-topic",
        topicId: "missing-topic",
        tenantKey: "tenant-2",
        chatId: "chat-3",
        startMessageId: "missing-topic-start",
      })).toThrow("FOREIGN KEY constraint failed");
      expect(() => store.createDiscussion({
        ...first,
        id: "discussion-active-collision",
        startMessageId: "active-collision-start",
      })).toThrow("This group already has an active Discussion");
    } finally {
      store.close();
    }
  });

  it("preserves exact constraint classification when saving a Discussion", () => {
    const path = databasePath();
    seedTopic(path);
    const store = SqliteDiscussionStore.open(path);
    const first = createDiscussion({
      id: "discussion-save-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "First save",
      starterPrincipalId: "tenant-1:user:owner",
      startMessageId: "save-start-1",
    });
    const second = createDiscussion({
      id: "discussion-save-2",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-2",
      question: "Second save",
      starterPrincipalId: "tenant-1:user:owner",
      startMessageId: "save-start-2",
    });
    store.createDiscussion(first);
    store.createDiscussion(second);
    try {
      expect(() => store.saveDiscussion({ ...first, startMessageId: "save-start-2" }))
        .toThrow("Discussion start message conflicts with another Discussion");
      expect(() => store.saveDiscussion({ ...second, chatId: first.chatId }))
        .toThrow("This group already has an active Discussion");
      expect(() => store.saveDiscussion({ ...first, topicId: "missing-topic" }))
        .toThrow("FOREIGN KEY constraint failed");
      expect(store.discussion(first.id)).toEqual(first);
      expect(store.discussion(second.id)).toEqual(second);
    } finally {
      store.close();
    }
  });

  it("persists turns and requeues interrupted work across restart", () => {
    const path = databasePath();
    seedTopic(path);
    const first = SqliteDiscussionStore.open(path);
    const discussion = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Question",
      starterPrincipalId: "tenant-1:user:owner",
    });
    first.createDiscussion(discussion);
    expect(first.claimTurn({
      id: "turn-1",
      discussionId: discussion.id,
      provider: "claude",
      round: 1,
      turnIndex: 0,
      startedAt: "2026-07-18T01:00:00.000Z",
    })).toBe(true);
    first.saveDiscussion({ ...discussion, activeTurnId: "turn-1" });
    first.close();

    const reopened = SqliteDiscussionStore.open(path);
    try {
      expect(reopened.recoverInterrupted()).toEqual({
        discussionIds: [discussion.id],
        turnIds: ["turn-1"],
      });
      expect(reopened.turn("turn-1")?.state).toBe("queued");
      expect(reopened.discussion(discussion.id)?.activeTurnId).toBeUndefined();
      expect(reopened.recoverInterrupted()).toEqual({ discussionIds: [], turnIds: [] });

      reopened.markTurnRunning("turn-1", "2026-07-18T01:01:00.000Z");
      reopened.completeTurn({
        id: "turn-1",
        externalSessionId: "external-1",
        text: "Visible answer",
        continueDiscussion: false,
        openQuestions: ["Remaining?"],
        completedAt: "2026-07-18T01:02:00.000Z",
      });
      expect(reopened.turn("turn-1")).toMatchObject({
        state: "completed",
        externalSessionId: "external-1",
        text: "Visible answer",
        continueDiscussion: false,
        openQuestions: ["Remaining?"],
      });
      expect(reopened.roundVotes(discussion.id, 1)).toEqual([false]);
    } finally {
      reopened.close();
    }
  });

  it("migrates legacy Discussions with a nullable durable start-message receipt", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE group_discussions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        question TEXT NOT NULL,
        starter_principal_id TEXT NOT NULL,
        state TEXT NOT NULL,
        round INTEGER NOT NULL,
        turn_index INTEGER NOT NULL,
        next_provider TEXT NOT NULL,
        round_order_json TEXT NOT NULL,
        max_rounds INTEGER NOT NULL,
        version INTEGER NOT NULL,
        preferred_provider TEXT,
        control_message_id TEXT,
        active_turn_id TEXT,
        summary_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO group_discussions VALUES (
        'legacy-discussion', 'legacy-topic', 'tenant-1', 'chat-1', 'Legacy question',
        'tenant-1:user:owner', 'completed', 1, 3, 'claude',
        '["claude","codex","copilot"]', 3, 4, NULL, NULL, NULL, 'Legacy summary',
        '2026-07-17T01:00:00.000Z', '2026-07-17T01:01:00.000Z'
      );
      INSERT INTO group_discussions VALUES (
        'legacy-paused-boundary', 'legacy-topic', 'tenant-1', 'chat-2', 'Paused boundary',
        'tenant-1:user:owner', 'paused', 2, 3, 'codex',
        '["codex","copilot","claude"]', 3, 4, NULL, NULL, NULL, NULL,
        '2026-07-17T02:00:00.000Z', '2026-07-17T02:01:00.000Z'
      );
      INSERT INTO group_discussions VALUES (
        'legacy-paused-mid-round', 'legacy-topic', 'tenant-1', 'chat-3', 'Paused mid-round',
        'tenant-1:user:owner', 'paused', 1, 2, 'copilot',
        '["claude","codex","copilot"]', 3, 3, NULL, NULL, NULL, NULL,
        '2026-07-17T03:00:00.000Z', '2026-07-17T03:01:00.000Z'
      );
      INSERT INTO group_discussions VALUES (
        'legacy-active-boundary', 'legacy-topic', 'tenant-1', 'chat-4', 'Active boundary',
        'tenant-1:user:owner', 'active', 2, 3, 'codex',
        '["codex","copilot","claude"]', 3, 4, NULL, NULL, NULL, NULL,
        '2026-07-17T04:00:00.000Z', '2026-07-17T04:01:00.000Z'
      );
    `);
    legacy.close();

    const store = SqliteDiscussionStore.open(path);
    try {
      expect(store.discussion("legacy-discussion")).toMatchObject({
        id: "legacy-discussion",
        state: "completed",
        summaryText: "Legacy summary",
        evaluatedTurnIndex: 0,
      });
      expect(store.discussion("legacy-discussion")).not.toHaveProperty("startMessageId");
      expect(store.discussionForStartMessage("legacy-message")).toBeUndefined();
      expect(store.discussion("legacy-paused-boundary")?.evaluatedTurnIndex).toBe(3);
      expect(store.discussion("legacy-paused-mid-round")?.evaluatedTurnIndex).toBe(0);
      expect(store.discussion("legacy-active-boundary")?.evaluatedTurnIndex).toBe(0);
    } finally {
      store.close();
    }
  });

  it("records the legacy boundary migration without rewriting current-schema markers", () => {
    const path = databasePath();
    seedTopic(path);
    const first = SqliteDiscussionStore.open(path);
    const pausedBoundary = {
      ...createDiscussion({
        id: "current-paused-boundary",
        topicId: "topic-1",
        tenantKey: "tenant-1",
        chatId: "chat-1",
        question: "Current fail-closed boundary",
        starterPrincipalId: "tenant-1:user:owner",
      }),
      state: "paused" as const,
      round: 2,
      turnIndex: 3,
      nextProvider: "codex" as const,
      roundOrder: ["codex", "copilot", "claude"] as const,
      evaluatedTurnIndex: 0,
    };
    first.createDiscussion(pausedBoundary);
    first.close();

    const reopenedOnce = SqliteDiscussionStore.open(path);
    try {
      expect(reopenedOnce.discussion(pausedBoundary.id)?.evaluatedTurnIndex).toBe(0);
    } finally {
      reopenedOnce.close();
    }
    const reopenedTwice = SqliteDiscussionStore.open(path);
    try {
      expect(reopenedTwice.discussion(pausedBoundary.id)?.evaluatedTurnIndex).toBe(0);
    } finally {
      reopenedTwice.close();
    }
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const migration = inspection.prepare(`
        SELECT COUNT(*) AS count FROM schema_migrations
        WHERE migration_key = 'discussion_evaluated_turn_backfill_v1'
      `).get() as { count: number };
      expect(Number(migration.count)).toBe(1);
    } finally {
      inspection.close();
    }
  });

  it("restarts a failed turn only while it is still the current Discussion slot", () => {
    const path = databasePath();
    seedTopic(path);
    const store = SqliteDiscussionStore.open(path);
    const discussion = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Question",
      starterPrincipalId: "tenant-1:user:owner",
    });
    store.createDiscussion(discussion);
    store.claimTurn({
      id: "failed-current-turn",
      discussionId: discussion.id,
      provider: "claude",
      round: 1,
      turnIndex: 0,
    });
    store.activateTurn(discussion.id, "failed-current-turn", 0, "claude");
    store.failTurn("failed-current-turn", "failed");

    try {
      store.restartTurn("failed-current-turn", "claude", 1);
      expect(store.turn("failed-current-turn")?.state).toBe("running");

      store.failTurn("failed-current-turn", "failed");
      const current = store.discussion(discussion.id);
      expect(current).toBeDefined();
      store.saveDiscussion(completeDiscussionTurn(current!, {
        provider: "claude",
        continueDiscussion: true,
      }));

      expect(() => store.restartTurn("failed-current-turn", "claude", 1))
        .toThrow(/restartable discussion turn not found/i);
      expect(store.turn("failed-current-turn")?.state).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("returns every persisted Discussion state for deterministic restart reconciliation", () => {
    const path = databasePath();
    seedTopic(path);
    const first = SqliteDiscussionStore.open(path);
    const states = ["active", "paused", "summarizing", "completed", "stopped", "failed"] as const;
    for (const [index, state] of states.entries()) {
      const discussion = createDiscussion({
        id: `discussion-${state}`,
        topicId: "topic-1",
        tenantKey: "tenant-1",
        chatId: `chat-${index}`,
        question: `${state} question`,
        starterPrincipalId: "tenant-1:user:owner",
        now: `2026-07-18T01:00:0${index}.000Z`,
      });
      first.createDiscussion(discussion);
      if (state !== "active") {
        first.saveDiscussion({
          ...discussion,
          state,
          ...(state === "completed" ? { summaryText: "Durable summary" } : {}),
        });
      }
    }
    first.close();

    const reopened = SqliteDiscussionStore.open(path);
    try {
      expect(reopened.recoverableDiscussions().map(({ state }) => state)).toEqual(states);
    } finally {
      reopened.close();
    }
  });

  it("installs and uses scoped indexes for steer-event startup reconciliation", () => {
    const path = databasePath();
    seedTopic(path);
    const store = SqliteDiscussionStore.open(path);
    store.close();
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const indexColumns = (name: string) => (database.prepare(`PRAGMA index_info('${name}')`)
        .all() as unknown as Array<{ name: string }>).map(({ name: column }) => column);
      expect(indexColumns("topic_events_type_idx")).toEqual(["type", "topic_id", "seq"]);
      expect(indexColumns("group_discussions_topic_idx")).toEqual(["topic_id", "id"]);
      expect(indexColumns("discussion_steers_event_idx"))
        .toEqual(["discussion_id", "topic_event_seq"]);
      expect(indexColumns("discussion_steers_unpublished_idx"))
        .toEqual(["topic_event_seq", "created_at", "id"]);

      const eventPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT topic_id, seq, type, actor_principal_id, payload_json, created_at
        FROM topic_events WHERE type = ? ORDER BY topic_id, seq
      `).all("discussion.steer.added") as unknown as Array<{ detail: string }>;
      expect(eventPlan.map(({ detail }) => detail).join("\n"))
        .toContain("topic_events_type_idx");

      const receiptPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT s.id
        FROM group_discussions d
        JOIN discussion_steers AS s INDEXED BY discussion_steers_event_idx
          ON s.discussion_id = d.id
        WHERE d.topic_id = ? AND s.topic_event_seq = ?
      `).all("topic-1", 1) as unknown as Array<{ detail: string }>;
      const receiptDetails = receiptPlan.map(({ detail }) => detail).join("\n");
      expect(receiptDetails).toContain("group_discussions_topic_idx");
      expect(receiptDetails).toContain("discussion_steers_event_idx");

      const unpublishedPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
               preferred_provider, status, created_at, consumed_at
        FROM discussion_steers
        WHERE topic_event_seq = 0
        ORDER BY created_at, id
      `).all() as unknown as Array<{ detail: string }>;
      const unpublishedDetails = unpublishedPlan.map(({ detail }) => detail).join("\n");
      expect(unpublishedDetails).toContain("discussion_steers_unpublished_idx");
      expect(unpublishedDetails).not.toMatch(/SCAN|USE TEMP B-TREE/i);
    } finally {
      database.close();
    }
  });
});
