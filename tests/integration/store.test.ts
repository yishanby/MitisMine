import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTopic } from "../../packages/domain/src/topic.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

function openTestStore(): { store: EventStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-store-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "test.db");
  return { store: EventStore.open(path), path };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("EventStore", () => {
  it("appends monotonic per-Topic events and updates the Topic projection", () => {
    const { store } = openTestStore();
    const topic = createTopic("Research", "tenant:user:owner", {
      id: "topic-1",
      now: "2026-07-17T12:00:00.000Z",
    });

    store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
      createdAt: topic.createdAt,
    });
    store.append({
      topicId: topic.id,
      type: "message.added",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { text: "question" },
      createdAt: "2026-07-17T12:01:00.000Z",
    });

    expect(store.events(topic.id).map((event) => event.seq)).toEqual([1, 2]);
    expect(store.topic(topic.id)).toMatchObject({
      title: "Research",
      lastEventSeq: 2,
    });
    store.close();
  });

  it("persists Topic projections and user cursors across restart", () => {
    const { store, path } = openTestStore();
    const topic = createTopic("Persistent", "tenant:user:owner", {
      id: "topic-restart",
    });
    store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    store.setCurrentTopic("tenant", topic.ownerPrincipalId, topic.id);
    store.close();

    const reopened = EventStore.open(path);
    expect(reopened.topic(topic.id)?.title).toBe("Persistent");
    expect(reopened.currentTopic("tenant", topic.ownerPrincipalId)).toBe(topic.id);
    expect(reopened.events(topic.id)).toHaveLength(1);
    reopened.close();
  });

  it("accepts each Feishu event exactly once per App", () => {
    const { store } = openTestStore();

    expect(store.recordFeishuEvent("hub", "event-1")).toBe(true);
    expect(store.recordFeishuEvent("hub", "event-1")).toBe(false);
    expect(store.recordFeishuEvent("claude", "event-1")).toBe(true);
    store.close();
  });

  it("releases only the matching Feishu event claim", () => {
    const { store } = openTestStore();

    try {
      expect(store.recordFeishuEvent("hub", "event-1")).toBe(true);
      expect(store.recordFeishuEvent("claude", "event-1")).toBe(true);
      expect(store.releaseFeishuEventClaim("hub", "event-1")).toBe(true);
      expect(store.recordFeishuEvent("hub", "event-1")).toBe(true);
      expect(store.recordFeishuEvent("claude", "event-1")).toBe(false);
    } finally {
      store.close();
    }
  });
});
