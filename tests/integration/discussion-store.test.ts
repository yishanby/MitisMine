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
});
