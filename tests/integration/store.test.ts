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

  it("reads one Topic event directly by Topic and sequence", () => {
    const { store } = openTestStore();
    const topic = createTopic("Direct event lookup", "tenant:user:owner", {
      id: "topic-event-lookup",
      now: "2026-07-18T08:00:00.000Z",
    });
    const otherTopic = createTopic("Other Topic", "tenant:user:owner", {
      id: "topic-event-lookup-other",
      now: "2026-07-18T08:00:00.000Z",
    });

    try {
      store.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: topic.ownerPrincipalId,
        payload: { topic },
        createdAt: topic.createdAt,
      });
      const event = store.append({
        topicId: topic.id,
        type: "message.added",
        actorPrincipalId: "tenant:user:member",
        payload: { text: "lookup this event" },
        createdAt: "2026-07-18T08:01:00.000Z",
      });
      store.append({
        topicId: otherTopic.id,
        type: "topic.created",
        actorPrincipalId: otherTopic.ownerPrincipalId,
        payload: { topic: otherTopic },
        createdAt: otherTopic.createdAt,
      });

      expect(store.event(topic.id, event.seq)).toEqual(event);
      expect(store.event(topic.id, event.seq + 100)).toBeUndefined();
      expect(store.event(otherTopic.id, event.seq)).toBeUndefined();
    } finally {
      store.close();
    }
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

  it("persists multiple direct Sessions and independent provider/user cursors", () => {
    const { store, path } = openTestStore();
    const topic = createTopic("Direct sessions", "tenant:user:owner", { id: "topic-direct" });
    store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    const architecture = store.createDirectSession({
      id: "session-architecture",
      topicId: topic.id,
      provider: "claude",
      title: "Architecture",
      now: "2026-07-18T01:00:00.000Z",
    });
    const evidence = store.createDirectSession({
      id: "session-evidence",
      topicId: topic.id,
      provider: "claude",
      title: "Evidence",
      now: "2026-07-18T02:00:00.000Z",
    });
    const codex = store.createDirectSession({
      id: "session-codex",
      topicId: topic.id,
      provider: "codex",
      title: "Architecture",
      now: "2026-07-18T03:00:00.000Z",
    });
    store.setCurrentDirectSession("tenant", topic.ownerPrincipalId, topic.id, "claude", evidence.id);
    store.setCurrentDirectSession("tenant", topic.ownerPrincipalId, topic.id, "codex", codex.id);
    store.setCurrentDirectSession("tenant", "tenant:user:other", topic.id, "claude", architecture.id);
    store.close();

    const reopened = EventStore.open(path);
    expect(reopened.listDirectSessions(topic.id, "claude").map((session) => session.title)).toEqual([
      "Evidence",
      "Architecture",
    ]);
    expect(reopened.currentDirectSession("tenant", topic.ownerPrincipalId, topic.id, "claude")?.id)
      .toBe(evidence.id);
    expect(reopened.currentDirectSession("tenant", topic.ownerPrincipalId, topic.id, "codex")?.id)
      .toBe(codex.id);
    expect(reopened.currentDirectSession("tenant", "tenant:user:other", topic.id, "claude")?.id)
      .toBe(architecture.id);
    reopened.close();
  });

  it("resolves, renames, updates, and archives direct Sessions safely", () => {
    const { store } = openTestStore();
    const topic = createTopic("Session lifecycle", "tenant:user:owner", { id: "topic-lifecycle" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    store.createDirectSession({
      id: "01SESSIONALPHA",
      topicId: topic.id,
      provider: "claude",
      title: "Alpha",
      now: "2026-07-18T01:00:00.000Z",
    });
    store.createDirectSession({
      id: "01SESSIONBETA",
      topicId: topic.id,
      provider: "claude",
      title: "Beta",
      now: "2026-07-18T02:00:00.000Z",
    });

    expect(store.resolveDirectSession(topic.id, "claude", "alpha")?.id).toBe("01SESSIONALPHA");
    expect(store.resolveDirectSession(topic.id, "claude", "01SESSIONB")?.title).toBe("Beta");
    expect(() => store.createDirectSession({
      id: "duplicate",
      topicId: topic.id,
      provider: "claude",
      title: "ALPHA",
    })).toThrow(/already exists/i);
    expect(() => store.resolveDirectSession(topic.id, "claude", "01SESSION")).toThrow(/ambiguous/i);

    store.renameDirectSession("01SESSIONALPHA", "Primary", "2026-07-18T03:00:00.000Z");
    store.updateDirectSession("01SESSIONALPHA", {
      externalSessionId: "external-alpha",
      contextWatermark: 7,
      status: "running",
      now: "2026-07-18T04:00:00.000Z",
    });
    expect(store.directSession("01SESSIONALPHA")).toMatchObject({
      title: "Primary",
      externalSessionId: "external-alpha",
      contextWatermark: 7,
      status: "running",
    });
    store.setCurrentDirectSession(
      "tenant",
      topic.ownerPrincipalId,
      topic.id,
      "claude",
      "01SESSIONALPHA",
    );
    store.archiveDirectSession("01SESSIONALPHA", "2026-07-18T05:00:00.000Z");
    expect(store.currentDirectSession("tenant", topic.ownerPrincipalId, topic.id, "claude"))
      .toBeUndefined();
    expect(() => store.setCurrentDirectSession(
      "tenant",
      topic.ownerPrincipalId,
      topic.id,
      "claude",
      "01SESSIONALPHA",
    )).toThrow(/archived/i);
    store.close();
  });

  it("rejects a cursor that crosses a Session Topic or provider", () => {
    const { store } = openTestStore();
    for (const id of ["topic-a", "topic-b"]) {
      const topic = createTopic(id, "tenant:user:owner", { id });
      store.append({ topicId: id, type: "topic.created", payload: { topic } });
    }
    store.createDirectSession({
      id: "session-a",
      topicId: "topic-a",
      provider: "claude",
      title: "main",
    });
    expect(() => store.setCurrentDirectSession(
      "tenant", "tenant:user:owner", "topic-b", "claude", "session-a",
    )).toThrow(/does not belong/i);
    expect(() => store.setCurrentDirectSession(
      "tenant", "tenant:user:owner", "topic-a", "codex", "session-a",
    )).toThrow(/does not belong/i);
    store.close();
  });

  it("migrates legacy direct agent Sessions to main idempotently", () => {
    const { store, path } = openTestStore();
    const topic = createTopic("Legacy", "tenant:user:owner", { id: "topic-legacy" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    store.upsertAgentSession({
      id: "legacy-direct",
      topicId: topic.id,
      provider: "claude",
      role: "direct",
      externalSessionId: "external-legacy",
      contextWatermark: 9,
      status: "active",
    });
    store.close();

    const migrated = EventStore.open(path);
    expect(migrated.listDirectSessions(topic.id, "claude")).toEqual([
      expect.objectContaining({
        id: "legacy-direct",
        title: "main",
        externalSessionId: "external-legacy",
        contextWatermark: 9,
      }),
    ]);
    migrated.close();
    const reopened = EventStore.open(path);
    expect(reopened.listDirectSessions(topic.id, "claude")).toHaveLength(1);
    reopened.close();
  });

  it("recovers a direct Session left running by a process restart", () => {
    const { store, path } = openTestStore();
    const topic = createTopic("Interrupted", "tenant:user:owner", { id: "topic-interrupted" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    const session = store.createDirectSession({
      id: "session-interrupted",
      topicId: topic.id,
      provider: "claude",
      title: "main",
    });
    store.updateDirectSession(session.id, { status: "running" });
    store.close();

    const reopened = EventStore.open(path);
    expect(reopened.directSession(session.id)?.status).toBe("active");
    reopened.close();
  });
});
