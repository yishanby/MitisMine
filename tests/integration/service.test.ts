import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createService } from "../../apps/control-plane/src/main.js";
import {
  AppConnectionRegistry,
  WorkerRegistry,
} from "../../apps/control-plane/src/health.js";
import { WorkerLeaseStore } from "../../apps/worker/src/main.js";
import { createQueuedRun } from "../../packages/domain/src/run-machine.js";
import { SqliteOrchestrationStore } from "../../packages/storage/src/orchestration.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { OutboxDispatcher } from "../../packages/feishu/src/outbox-dispatcher.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("control-plane health", () => {
  it("keeps an in-process worker registered without remote heartbeats", () => {
    const workers = new WorkerRegistry(1_000);
    workers.connectPersistent("local");
    expect(workers.connectedCount(new Date("2099-01-01T00:00:00.000Z"))).toBe(1);
  });

  it("reports not-ready until store, four apps, and a worker are healthy", async () => {
    const apps = new AppConnectionRegistry();
    for (const role of ["hub", "claude", "codex", "copilot"] as const) apps.connect(role);
    const workers = new WorkerRegistry();
    const service = await createService({
      storeHealthy: () => true,
      apps,
      workers,
    });

    expect((await service.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await service.inject({ url: "/ready" })).statusCode).toBe(503);
    workers.connect("local");
    expect((await service.inject({ url: "/ready" })).statusCode).toBe(200);
    apps.disconnect("codex");
    expect((await service.inject({ url: "/ready" })).statusCode).toBe(503);
    await service.close();
  });

  it("runs graceful shutdown hooks once in reverse registration order", async () => {
    const order: string[] = [];
    const apps = new AppConnectionRegistry();
    for (const role of ["hub", "claude", "codex", "copilot"] as const) apps.connect(role);
    const workers = new WorkerRegistry();
    workers.connect("local");
    const service = await createService({
      storeHealthy: () => true,
      apps,
      workers,
      shutdown: [
        async () => { order.push("store"); },
        async () => { order.push("outbox"); },
      ],
    });

    await service.close();
    await service.close();
    expect(order).toEqual(["outbox", "store"]);
  });
});

describe("WorkerLeaseStore", () => {
  it("requeues expired leases across process restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "leases.db");
    const first = WorkerLeaseStore.open(path);
    first.lease(
      "task-1",
      "worker-1",
      new Date("2026-07-17T12:00:00.000Z"),
      1_000,
    );
    first.close();

    const second = WorkerLeaseStore.open(path);
    expect(second.requeueExpired(new Date("2026-07-17T12:00:02.000Z"))).toEqual(["task-1"]);
    expect(second.status("task-1")).toBe("queued");
    second.close();
  });

  it("keeps a lease alive when the worker heartbeats", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const store = WorkerLeaseStore.open(join(directory, "leases.db"));
    store.lease("task-1", "worker-1", new Date("2026-07-17T12:00:00.000Z"), 1_000);
    store.heartbeat("task-1", "worker-1", new Date("2026-07-17T12:00:00.500Z"), 2_000);

    expect(store.requeueExpired(new Date("2026-07-17T12:00:02.000Z"))).toEqual([]);
    expect(store.status("task-1")).toBe("leased");
    store.close();
  });
});

describe("SqliteOrchestrationStore", () => {
  it("restores a non-terminal checkpoint and call journal after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-checkpoint-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.db");
    const first = SqliteOrchestrationStore.open(path);
    const checkpoint = {
      run: createQueuedRun({
        id: "run-1",
        topicId: "topic-1",
        question: "question",
        coordinatorProvider: "claude",
      }),
      cwd: process.cwd(),
      phases: [],
      reports: {},
      sessions: {},
      reviews: [],
      degradedProviders: [],
    };
    first.save(checkpoint);
    first.record({
      runId: "run-1",
      topicId: "topic-1",
      type: "agent.call.started",
      provider: "claude",
      phase: "independent_research",
      createdAt: "2026-07-17T12:00:00.000Z",
    });
    first.close();

    const second = SqliteOrchestrationStore.open(path);
    expect(second.load("run-1")?.run.state).toBe("queued");
    expect(second.runCount("topic-1")).toBe(1);
    expect(second.records("run-1")).toHaveLength(1);
    second.close();
  });
});

describe("OutboxDispatcher", () => {
  it("marks successful sends and schedules failed sends for retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-outbox-"));
    temporaryDirectories.push(directory);
    const outbox = DurableOutbox.open(join(directory, "outbox.db"));
    outbox.enqueue({
      id: "one",
      appRole: "hub",
      receiveId: "chat",
      payload: { text: "one" },
      idempotencyKey: "one",
      nextAttemptAt: "2026-07-17T12:00:00.000Z",
    });
    outbox.enqueue({
      id: "two",
      appRole: "hub",
      receiveId: "chat",
      payload: { text: "two" },
      idempotencyKey: "two",
      nextAttemptAt: "2026-07-17T12:00:00.000Z",
    });
    const sent: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox,
      now: () => new Date("2026-07-17T12:00:01.000Z"),
      sender: {
        send: async (message) => {
          sent.push(message.id);
          if (message.id === "two") throw new Error("rate limited");
        },
      },
    });

    await dispatcher.flushOnce();
    expect(sent).toEqual(["one", "two"]);
    expect(outbox.pending("2026-07-17T12:00:01.000Z")).toEqual([]);
    expect(outbox.pending("2026-07-17T12:00:04.000Z")).toMatchObject([
      { id: "two", attempts: 1, status: "retry" },
    ]);
    outbox.close();
  });
});
