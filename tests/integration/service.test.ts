import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChannelDispatcher, createService } from "../../apps/control-plane/src/main.js";
import type {
  AdapterRegistry,
  AgentAdapter,
  AgentTask,
  ProviderName,
  ResumeAgentTask,
} from "../../packages/agent-adapters/src/index.js";
import {
  AppConnectionRegistry,
  WorkerRegistry,
} from "../../apps/control-plane/src/health.js";
import { WorkerLeaseStore } from "../../apps/worker/src/main.js";
import { createQueuedRun } from "../../packages/domain/src/run-machine.js";
import { createTopic } from "../../packages/domain/src/topic.js";
import { SqliteOrchestrationStore } from "../../packages/storage/src/orchestration.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { OutboxDispatcher } from "../../packages/feishu/src/outbox-dispatcher.js";
import { FeishuGateway, type FeishuMessageEvent } from "../../packages/feishu/src/gateway.js";
import { EventStore } from "../../packages/storage/src/store.js";

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

describe("ChannelDispatcher Context Pack", () => {
  it("passes Topic notes and the current watermark to research and direct provider prompts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-context-pack-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    const researchPacks: string[] = [];
    const directPrompts: string[] = [];
    let directCalled: (() => void) | undefined;
    const directCall = new Promise<void>((resolve) => { directCalled = resolve; });
    const adapter = (provider: ProviderName): AgentAdapter => {
      const invoke = async (task: AgentTask | ResumeAgentTask) => {
        directPrompts.push(task.prompt);
        directCalled?.();
        return {
          provider,
          externalSessionId: `${provider}-direct-session`,
          events: [{ type: "final" as const, text: "direct answer" }],
        };
      };
      return { provider, start: invoke, resume: invoke };
    };
    const adapters: AdapterRegistry = {
      claude: adapter("claude"),
      codex: adapter("codex"),
      copilot: adapter("copilot"),
    };
    const orchestrator = {
      start: async (input: { contextPack?: string; runId: string; topicId: string; question: string }) => {
        researchPacks.push(input.contextPack ?? "");
        const queued = createQueuedRun({
          id: input.runId,
          topicId: input.topicId,
          question: input.question,
          coordinatorProvider: "claude",
        });
        return {
          run: { ...queued, state: "completed" as const },
          phases: [],
          reports: {},
          sessions: {},
          reviews: [],
          degradedProviders: [],
          subtaskResults: {},
        };
      },
      resume: async () => { throw new Error("unexpected resume"); },
      cancel: async () => {},
    };
    const dispatcher = new ChannelDispatcher({
      orchestrator,
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters,
      dataDirectory: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });
    let nextTopic = 0;
    const gateway = new FeishuGateway({
      store,
      outbox,
      dispatcher,
      idFactory: () => `topic-${++nextTopic}`,
    });
    const event = (
      appRole: FeishuMessageEvent["appRole"],
      text: string,
      eventId: string,
    ): FeishuMessageEvent => ({
      appRole,
      text,
      eventId,
      tenantKey: "tenant",
      userId: "owner",
      openId: `${appRole}-open`,
      messageId: `${eventId}-message`,
      chatId: "chat",
    });

    try {
      await gateway.receive(event("hub", "/topic new Context", "context-create"));
      await gateway.receive(event("hub", "/note remember the launch date", "context-note"));
      await gateway.receive(event("hub", "/research investigate", "context-research"));

      expect(researchPacks).toHaveLength(1);
      expect(researchPacks[0]).toContain("remember the launch date");
      expect(researchPacks[0]).toContain('"watermark":3');

      await gateway.receive(event("claude", "continue directly", "context-direct"));
      await directCall;
      expect(directPrompts.at(-1)).toContain("CONTEXT_PACK:");
      expect(directPrompts.at(-1)).toContain("remember the launch date");
      expect(directPrompts.at(-1)).toContain('"watermark":5');
    } finally {
      store.close();
      outbox.close();
    }
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

  it("restores Topic research sessions after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-topic-session-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sessions.db");
    const events = EventStore.open(path);
    const topic = createTopic("Persistent sessions", "tenant:user:owner", { id: "topic-session" });
    events.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    events.close();

    const first = SqliteOrchestrationStore.open(path);
    first.saveTopicSession("topic-session", "claude", "claude-external-1");
    first.close();

    const second = SqliteOrchestrationStore.open(path);
    expect(second.topicSession("topic-session", "claude")).toBe("claude-external-1");
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
