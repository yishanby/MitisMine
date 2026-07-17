import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDiscussion } from "../../packages/domain/src/discussion.js";
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
});
