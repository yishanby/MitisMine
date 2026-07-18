import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChannelDispatcher,
  createService,
  handleDiscussionCardAction,
} from "../../apps/control-plane/src/main.js";
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
import { feishuMessageData } from "../../packages/feishu/src/live.js";
import { FeishuGateway, type FeishuMessageEvent } from "../../packages/feishu/src/gateway.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

class ManualRecoveryScheduler {
  readonly callbacks = new Set<() => void>();

  setInterval(callback: () => void): object {
    this.callbacks.add(callback);
    return callback;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as () => void);
  }

  tick(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

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

  it("attempts every shutdown hook even when one cleanup fails", async () => {
    const order: string[] = [];
    const service = await createService({
      storeHealthy: () => true,
      apps: new AppConnectionRegistry(),
      workers: new WorkerRegistry(),
      shutdown: [
        () => { order.push("store"); },
        () => { order.push("broken"); throw new Error("cleanup failed"); },
        () => { order.push("socket"); },
      ],
    });

    await expect(service.close()).rejects.toThrow("cleanup failed");
    expect(order).toEqual(["socket", "broken", "store"]);
  });
});

describe("Discussion control card callback", () => {
  it("routes a Hub card action with the operator's stable principal", async () => {
    const controls: unknown[] = [];
    const result = await handleDiscussionCardAction(
      "hub",
      {
        action: {
          value: {
            action: "discussion.pause",
            discussionId: "discussion-1",
            version: 3,
          },
        },
        operator: { user_id: "member-1" },
      },
      {
        discussion: () => ({ tenantKey: "tenant-1", version: 3 }),
        control: async (...args) => { controls.push(args); },
      },
    );

    expect(controls).toEqual([
      ["discussion-1", "pause", "tenant-1:user:member-1"],
    ]);
    expect(result).toEqual({ toast: { type: "success", content: "已暂停" } });
  });

  it("rejects provider-App callbacks and invalid Discussion actions", async () => {
    const dependencies = {
      discussion: () => ({ tenantKey: "tenant-1", version: 1 }),
      control: async () => {},
    };
    await expect(handleDiscussionCardAction("claude", {
      action: { value: { action: "discussion.pause", discussionId: "discussion-1", version: 1 } },
      operator: { user_id: "member-1" },
    }, dependencies)).rejects.toThrow(/Hub/i);
    await expect(handleDiscussionCardAction("hub", {
      action: { value: { action: "discussion.delete", discussionId: "discussion-1", version: 1 } },
      operator: { user_id: "member-1" },
    }, dependencies)).rejects.toThrow(/invalid/i);
  });

  it("ignores a replayed action from a stale control-card version", async () => {
    const controls: unknown[] = [];
    const result = await handleDiscussionCardAction("hub", {
      action: { value: { action: "discussion.pause", discussionId: "discussion-1", version: 2 } },
      operator: { user_id: "member-1" },
    }, {
      discussion: () => ({ tenantKey: "tenant-1", version: 3 }),
      control: async (...args) => { controls.push(args); },
    });

    expect(controls).toEqual([]);
    expect(result).toEqual({
      toast: { type: "warning", content: "状态已更新，请使用最新卡片" },
    });
  });
});

describe("control-plane recovery", () => {
  it("periodically reaps leases, reports resume failures, and retries non-terminal Runs", async () => {
    const module = await import("../../apps/control-plane/src/main.js") as Record<string, unknown>;
    expect(typeof module.RecoverySupervisor).toBe("function");
    const RecoverySupervisor = module.RecoverySupervisor as new (options: {
      leases: { requeueExpired(now?: Date): string[] };
      checkpoints: { nonTerminalRunIds(): string[] };
      orchestrator: { resume(runId: string): Promise<unknown> };
      scheduler: ManualRecoveryScheduler;
      intervalMs: number;
      onError(runId: string | undefined, error: unknown): void;
    }) => {
      runOnce(): Promise<void>;
      start(): void;
      stop(): Promise<void>;
    };
    const scheduler = new ManualRecoveryScheduler();
    const errors: Array<{ runId: string | undefined; error: unknown }> = [];
    let reapCount = 0;
    let resumeAttempts = 0;
    let nonTerminal = ["run-retry"];
    const recovery = new RecoverySupervisor({
      leases: { requeueExpired: () => { reapCount += 1; return []; } },
      checkpoints: { nonTerminalRunIds: () => nonTerminal },
      orchestrator: {
        resume: async () => {
          resumeAttempts += 1;
          if (resumeAttempts === 1) throw new Error("resume failed once");
          nonTerminal = [];
        },
      },
      scheduler,
      intervalMs: 100,
      onError: (runId, error) => { errors.push({ runId, error }); },
    });

    await recovery.runOnce();
    expect({ reapCount, resumeAttempts }).toEqual({ reapCount: 1, resumeAttempts: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.runId).toBe("run-retry");

    recovery.start();
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ reapCount, resumeAttempts }).toEqual({ reapCount: 2, resumeAttempts: 2 });
    await recovery.stop();
    expect(scheduler.callbacks.size).toBe(0);
  });

  it("never resumes the same Run concurrently", async () => {
    const module = await import("../../apps/control-plane/src/main.js") as Record<string, unknown>;
    const RecoverySupervisor = module.RecoverySupervisor as new (options: {
      leases: { requeueExpired(now?: Date): string[] };
      checkpoints: { nonTerminalRunIds(): string[] };
      orchestrator: { resume(runId: string): Promise<unknown> };
      scheduler: ManualRecoveryScheduler;
      intervalMs: number;
    }) => { runOnce(): Promise<void>; stop(): Promise<void> };
    const scheduler = new ManualRecoveryScheduler();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let resumeAttempts = 0;
    const recovery = new RecoverySupervisor({
      leases: { requeueExpired: () => [] },
      checkpoints: { nonTerminalRunIds: () => ["run-active"] },
      orchestrator: { resume: async () => { resumeAttempts += 1; await blocked; } },
      scheduler,
      intervalMs: 100,
    });

    const first = recovery.runOnce();
    const second = recovery.runOnce();
    await Promise.resolve();
    expect(resumeAttempts).toBe(1);
    release?.();
    await Promise.all([first, second]);
    await recovery.stop();
  });

  it("cancels an in-flight recovery before stop waits for it", async () => {
    const module = await import("../../apps/control-plane/src/main.js") as Record<string, unknown>;
    const RecoverySupervisor = module.RecoverySupervisor as new (options: {
      leases: { requeueExpired(now?: Date): string[] };
      checkpoints: { nonTerminalRunIds(): string[] };
      orchestrator: {
        resume(runId: string): Promise<unknown>;
        cancel(runId: string): Promise<void>;
      };
      scheduler: ManualRecoveryScheduler;
      intervalMs: number;
    }) => { runOnce(): Promise<void>; stop(): Promise<void> };
    const scheduler = new ManualRecoveryScheduler();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const cancelled: string[] = [];
    const recovery = new RecoverySupervisor({
      leases: { requeueExpired: () => [] },
      checkpoints: { nonTerminalRunIds: () => ["run-shutdown"] },
      orchestrator: {
        resume: async () => { await blocked; },
        cancel: async (runId) => { cancelled.push(runId); release?.(); },
      },
      scheduler,
      intervalMs: 100,
    });

    const running = recovery.runOnce();
    await Promise.resolve();
    const stopping = recovery.stop();
    await Promise.resolve();
    expect(cancelled).toEqual(["run-shutdown"]);
    release?.();
    await Promise.all([running, stopping]);
  });
});

describe("ChannelDispatcher Context Pack", () => {
  it("aborts and drains a pending direct provider call before shutdown returns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-shutdown-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "direct.db");
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    const topic = createTopic("Direct shutdown", "tenant:user:owner", { id: "topic-direct-shutdown" });
    store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    const directSession = store.createDirectSession({
      id: "direct-session-shutdown",
      topicId: topic.id,
      provider: "claude",
      title: "main",
    });
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const waitingAdapter = (provider: ProviderName): AgentAdapter => ({
      provider,
      start: async (task) => {
        started?.();
        return new Promise<never>((_resolve, reject) => {
          task.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(task.signal?.reason ?? new Error("aborted"));
          }, { once: true });
        });
      },
      resume: async () => { throw new Error("unexpected resume"); },
    });
    const dispatcher = new ChannelDispatcher({
      orchestrator: {
        start: async () => { throw new Error("unexpected research"); },
        resume: async () => { throw new Error("unexpected resume"); },
        cancel: async () => {},
      },
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters: {
        claude: waitingAdapter("claude"),
        codex: waitingAdapter("codex"),
        copilot: waitingAdapter("copilot"),
      },
      agentWorkspaceRoot: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });

    try {
      await dispatcher.dispatch({
        mode: "direct",
        provider: "claude",
        directSessionId: directSession.id,
        topicId: topic.id,
        topicTitle: topic.title,
        principalId: topic.ownerPrincipalId,
        question: "wait",
        idempotencyKey: "direct-shutdown",
        replyAppRole: "claude",
        receiveId: "chat",
      });
      await providerStarted;
      await dispatcher.shutdown();

      expect(aborted).toBe(true);
      expect(store.events(topic.id).some((event) => event.type === "agent.direct.completed"))
        .toBe(false);
    } finally {
      store.close();
      outbox.close();
    }
  });

  it("restores a direct Session after an error-only result without recording completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-error-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "direct.db");
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    const topic = createTopic("Direct failure", "tenant:user:owner", { id: "topic-direct-error" });
    store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    const directSession = store.createDirectSession({
      id: "direct-session-error",
      topicId: topic.id,
      provider: "claude",
      title: "main",
    });
    const failedAdapter = (provider: ProviderName): AgentAdapter => ({
      provider,
      start: async () => ({
        provider,
        externalSessionId: `${provider}-failed-session`,
        events: [{ type: "error", code: "process_exit", message: "failed" }],
      }),
      resume: async () => { throw new Error("unexpected resume"); },
    });
    const dispatcher = new ChannelDispatcher({
      orchestrator: {
        start: async () => { throw new Error("unexpected research"); },
        resume: async () => { throw new Error("unexpected resume"); },
        cancel: async () => {},
      },
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters: {
        claude: failedAdapter("claude"),
        codex: failedAdapter("codex"),
        copilot: failedAdapter("copilot"),
      },
      agentWorkspaceRoot: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });

    try {
      await dispatcher.dispatch({
        mode: "direct",
        provider: "claude",
        directSessionId: directSession.id,
        topicId: topic.id,
        topicTitle: topic.title,
        principalId: topic.ownerPrincipalId,
        question: "fail safely",
        idempotencyKey: "direct-error",
        replyAppRole: "claude",
        receiveId: "chat",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.directSession(directSession.id)?.status).toBe("active");
      expect(store.directSession(directSession.id)?.externalSessionId).toBeUndefined();
      expect(store.events(topic.id).some((event) => event.type === "agent.direct.completed"))
        .toBe(false);
    } finally {
      store.close();
      outbox.close();
    }
  });

  it("starts and resumes the selected direct Session without crossing external IDs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-selection-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "direct.db");
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    const topic = createTopic("Direct selection", "tenant:user:owner", { id: "topic-selection" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    const one = store.createDirectSession({
      id: "direct-one", topicId: topic.id, provider: "claude", title: "One",
    });
    const two = store.createDirectSession({
      id: "direct-two", topicId: topic.id, provider: "claude", title: "Two",
    });
    const starts: string[] = [];
    const resumes: string[] = [];
    const adapter: AgentAdapter = {
      provider: "claude",
      start: async () => {
        const externalSessionId = `external-${starts.length + 1}`;
        starts.push(externalSessionId);
        return {
          provider: "claude",
          externalSessionId,
          events: [{ type: "final", text: `started ${externalSessionId}` }],
        };
      },
      resume: async (task) => {
        resumes.push(task.externalSessionId);
        return {
          provider: "claude",
          externalSessionId: task.externalSessionId,
          events: [{ type: "final", text: `resumed ${task.externalSessionId}` }],
        };
      },
    };
    const dispatcher = new ChannelDispatcher({
      orchestrator: {
        start: async () => { throw new Error("unexpected research"); },
        resume: async () => { throw new Error("unexpected research resume"); },
        cancel: async () => {},
      },
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters: { claude: adapter, codex: adapter, copilot: adapter },
      agentWorkspaceRoot: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });
    const direct = (directSessionId: string, question: string, key: string) => dispatcher.dispatch({
      mode: "direct" as const,
      provider: "claude" as const,
      directSessionId,
      topicId: topic.id,
      topicTitle: topic.title,
      principalId: topic.ownerPrincipalId,
      question,
      idempotencyKey: key,
      replyAppRole: "claude" as const,
      receiveId: "chat",
    });

    try {
      await direct(one.id, "first one", "selection-one-first");
      await waitUntil(() => starts.length === 1, "first direct start");
      await direct(two.id, "first two", "selection-two-first");
      await waitUntil(() => starts.length === 2, "second direct start");
      await direct(one.id, "second one", "selection-one-second");
      await waitUntil(() => resumes.length === 1, "direct resume");

      expect(resumes).toEqual(["external-1"]);
      expect(store.directSession(one.id)?.externalSessionId).toBe("external-1");
      expect(store.directSession(two.id)?.externalSessionId).toBe("external-2");
      expect(store.events(topic.id)
        .filter((event) => event.type === "agent.direct.completed")
        .map((event) => (event.payload as { directSessionId?: string }).directSessionId))
        .toEqual([one.id, two.id, one.id]);
    } finally {
      await dispatcher.shutdown();
      store.close();
      outbox.close();
    }
  });

  it("serializes turns within one direct Session while different Sessions run concurrently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-concurrency-"));
    temporaryDirectories.push(directory);
    const store = EventStore.open(join(directory, "direct.db"));
    const outbox = DurableOutbox.open(join(directory, "direct.db"));
    const topic = createTopic("Direct concurrency", "tenant:user:owner", { id: "topic-concurrency" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    const same = store.createDirectSession({
      id: "session-same", topicId: topic.id, provider: "claude", title: "Same",
    });
    const other = store.createDirectSession({
      id: "session-other", topicId: topic.id, provider: "claude", title: "Other",
    });
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseOther: (() => void) | undefined;
    const otherBlocked = new Promise<void>((resolve) => { releaseOther = resolve; });
    const calls: string[] = [];
    const invoke = async (task: AgentTask | ResumeAgentTask) => {
      const label = task.prompt.includes("same second")
        ? "same second"
        : task.prompt.includes("same first")
          ? "same first"
          : "other";
      calls.push(label);
      if (label === "same first") await firstBlocked;
      if (label === "other") await otherBlocked;
      return {
        provider: "claude" as const,
        externalSessionId: label === "other" ? "external-other" : "external-same",
        events: [{ type: "final" as const, text: label }],
      };
    };
    const adapter: AgentAdapter = { provider: "claude", start: invoke, resume: invoke };
    const dispatcher = new ChannelDispatcher({
      orchestrator: {
        start: async () => { throw new Error("unexpected research"); },
        resume: async () => { throw new Error("unexpected research resume"); },
        cancel: async () => {},
      },
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters: { claude: adapter, codex: adapter, copilot: adapter },
      agentWorkspaceRoot: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });
    const direct = (directSessionId: string, question: string, key: string) => dispatcher.dispatch({
      mode: "direct" as const,
      provider: "claude" as const,
      directSessionId,
      topicId: topic.id,
      topicTitle: topic.title,
      principalId: topic.ownerPrincipalId,
      question,
      idempotencyKey: key,
      replyAppRole: "claude" as const,
      receiveId: "chat",
    });

    try {
      await direct(same.id, "same first", "concurrency-first");
      await waitUntil(() => calls.includes("same first"), "blocked first turn");
      await direct(same.id, "same second", "concurrency-second");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).not.toContain("same second");

      await direct(other.id, "other turn", "concurrency-other");
      await waitUntil(() => calls.includes("other"), "parallel other Session");
      store.archiveDirectSession(other.id);
      releaseOther?.();
      await waitUntil(
        () => store.events(topic.id).some((event) =>
          event.type === "agent.direct.completed"
          && (event.payload as { directSessionId?: string }).directSessionId === other.id),
        "archived in-flight completion",
      );
      expect(store.directSession(other.id)?.status).toBe("archived");
      releaseFirst?.();
      await waitUntil(() => calls.includes("same second"), "serialized second turn");
      expect(calls.indexOf("other")).toBeLessThan(calls.indexOf("same second"));
    } finally {
      releaseFirst?.();
      releaseOther?.();
      await dispatcher.shutdown();
      store.close();
      outbox.close();
    }
  });

  it("includes shared Topic context but excludes other direct Session conversations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-isolation-"));
    temporaryDirectories.push(directory);
    const store = EventStore.open(join(directory, "direct.db"));
    const outbox = DurableOutbox.open(join(directory, "direct.db"));
    const topic = createTopic("Direct isolation", "tenant:user:owner", { id: "topic-isolation" });
    store.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
    store.append({
      topicId: topic.id,
      type: "message.added",
      payload: { text: "shared launch note", note: true },
    });
    const alpha = store.createDirectSession({
      id: "session-alpha", topicId: topic.id, provider: "claude", title: "Alpha",
    });
    const beta = store.createDirectSession({
      id: "session-beta", topicId: topic.id, provider: "claude", title: "Beta",
    });
    store.append({
      topicId: topic.id,
      type: "agent.direct.message",
      payload: { directSessionId: alpha.id, provider: "claude", text: "alpha private question" },
    });
    store.append({
      topicId: topic.id,
      type: "agent.direct.completed",
      payload: { directSessionId: alpha.id, provider: "claude", text: "alpha private answer" },
    });
    store.append({
      topicId: topic.id,
      type: "agent.direct.message",
      payload: { directSessionId: beta.id, provider: "claude", text: "beta own history" },
    });
    let prompt = "";
    const adapter: AgentAdapter = {
      provider: "claude",
      start: async (task) => {
        prompt = task.prompt;
        return {
          provider: "claude",
          externalSessionId: "external-beta",
          events: [{ type: "final", text: "beta answer" }],
        };
      },
      resume: async () => { throw new Error("unexpected resume"); },
    };
    const dispatcher = new ChannelDispatcher({
      orchestrator: {
        start: async () => { throw new Error("unexpected research"); },
        resume: async () => { throw new Error("unexpected research resume"); },
        cancel: async () => {},
      },
      checkpoints: { load: () => undefined, latestForTopic: () => undefined },
      store,
      outbox,
      adapters: { claude: adapter, codex: adapter, copilot: adapter },
      agentWorkspaceRoot: directory,
      approval: { request: () => { throw new Error("unexpected approval"); } },
    });

    try {
      await dispatcher.dispatch({
        mode: "direct",
        provider: "claude",
        directSessionId: beta.id,
        topicId: topic.id,
        topicTitle: topic.title,
        principalId: topic.ownerPrincipalId,
        question: "beta current question",
        idempotencyKey: "isolation-beta",
        replyAppRole: "claude",
        receiveId: "chat",
      });
      await waitUntil(() => prompt.length > 0, "isolated direct prompt");
      expect(prompt).toContain("shared launch note");
      expect(prompt).toContain("beta own history");
      expect(prompt).not.toContain("alpha private question");
      expect(prompt).not.toContain("alpha private answer");
    } finally {
      await dispatcher.shutdown();
      store.close();
      outbox.close();
    }
  });

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
      agentWorkspaceRoot: directory,
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
  it("records completed, requeued, and failed lease transitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const store = WorkerLeaseStore.open(join(directory, "leases.db"));
    const now = new Date("2026-07-17T12:00:00.000Z");

    try {
      store.lease("completed-task", "local", now, 1_000);
      store.complete("completed-task", "local", new Date("2026-07-17T12:00:00.100Z"));
      store.lease("queued-task", "local", now, 1_000);
      store.requeue("queued-task", "local", new Date("2026-07-17T12:00:00.100Z"));
      store.lease("failed-task", "local", now, 1_000);
      store.fail("failed-task", "local", new Date("2026-07-17T12:00:00.100Z"));

      expect(store.status("completed-task")).toBe("completed");
      expect(store.history("completed-task")).toEqual(["leased", "completed"]);
      expect(store.status("queued-task")).toBe("queued");
      expect(store.history("queued-task")).toEqual(["leased", "queued"]);
      expect(store.status("failed-task")).toBe("failed");
      expect(store.history("failed-task")).toEqual(["leased", "failed"]);
    } finally {
      store.close();
    }
  });

  it("does not let another worker finish an active lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const store = WorkerLeaseStore.open(join(directory, "leases.db"));
    try {
      store.lease("task-1", "worker-1", new Date("2026-07-17T12:00:00.000Z"), 1_000);

      expect(() => store.complete(
        "task-1",
        "worker-2",
        new Date("2026-07-17T12:00:00.100Z"),
      )).toThrow(/active worker lease/i);
      expect(store.status("task-1")).toBe("leased");
    } finally {
      store.close();
    }
  });

  it("does not let another worker steal an unexpired lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const store = WorkerLeaseStore.open(join(directory, "leases.db"));
    try {
      store.lease("task-1", "worker-1", new Date("2026-07-17T12:00:00.000Z"), 1_000);

      expect(() => store.lease(
        "task-1",
        "worker-2",
        new Date("2026-07-17T12:00:00.100Z"),
        1_000,
      )).toThrow(/already leased/i);
      expect(store.history("task-1")).toEqual(["leased"]);
    } finally {
      store.close();
    }
  });

  it("does not let the same worker reacquire an unexpired lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
    temporaryDirectories.push(directory);
    const store = WorkerLeaseStore.open(join(directory, "leases.db"));
    try {
      store.lease("task-1", "worker-1", new Date("2026-07-17T12:00:00.000Z"), 1_000);

      expect(() => store.lease(
        "task-1",
        "worker-1",
        new Date("2026-07-17T12:00:00.100Z"),
        1_000,
      )).toThrow(/already leased/i);
      expect(store.history("task-1")).toEqual(["leased"]);
    } finally {
      store.close();
    }
  });

  it.each(["completed", "failed"] as const)(
    "does not reacquire a %s task",
    (terminalStatus) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-leases-"));
      temporaryDirectories.push(directory);
      const store = WorkerLeaseStore.open(join(directory, "leases.db"));
      try {
        store.lease("task-1", "worker-1", new Date("2026-07-17T12:00:00.000Z"), 1_000);
        if (terminalStatus === "completed") {
          store.complete("task-1", "worker-1", new Date("2026-07-17T12:00:00.100Z"));
        } else {
          store.fail("task-1", "worker-1", new Date("2026-07-17T12:00:00.100Z"));
        }

        expect(() => store.lease(
          "task-1",
          "worker-2",
          new Date("2026-07-17T12:00:02.000Z"),
          1_000,
        )).toThrow(/not available|terminal/i);
        expect(store.status("task-1")).toBe(terminalStatus);
      } finally {
        store.close();
      }
    },
  );

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
    try {
      expect(second.requeueExpired(new Date("2026-07-17T12:00:02.000Z"))).toEqual(["task-1"]);
      expect(second.status("task-1")).toBe("queued");
      expect(second.history("task-1")).toEqual(["leased", "queued"]);
    } finally {
      second.close();
    }
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
  it("reuses the same Feishu uuid when a post-send failure is replayed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-outbox-replay-"));
    temporaryDirectories.push(directory);
    const outbox = DurableOutbox.open(join(directory, "outbox.db"));
    outbox.enqueue({
      id: "replay",
      appRole: "hub",
      receiveId: "chat",
      payload: { text: "replay" },
      idempotencyKey: "dispatch:stable-replay-key",
      nextAttemptAt: "2026-07-17T12:00:00.000Z",
    });
    let now = new Date("2026-07-17T12:00:00.000Z");
    const uuids: string[] = [];
    let sends = 0;
    const dispatcher = new OutboxDispatcher({
      outbox,
      now: () => now,
      sender: {
        send: async (message) => {
          uuids.push(feishuMessageData(message).uuid);
          sends += 1;
          if (sends === 1) throw new Error("connection lost after remote acceptance");
        },
      },
    });

    try {
      await dispatcher.flushOnce();
      now = new Date("2026-07-17T12:00:03.000Z");
      await dispatcher.flushOnce();

      expect(uuids).toHaveLength(2);
      expect(uuids[0]).toBe(uuids[1]);
      expect(uuids[0]).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      outbox.close();
    }
  });

  it("waits for an in-flight send when stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-outbox-stop-"));
    temporaryDirectories.push(directory);
    const outbox = DurableOutbox.open(join(directory, "outbox.db"));
    outbox.enqueue({
      id: "delayed",
      appRole: "hub",
      receiveId: "chat",
      payload: { text: "delayed" },
      idempotencyKey: "delayed",
    });
    let sendStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    let finishSend: (() => void) | undefined;
    const finish = new Promise<void>((resolve) => { finishSend = resolve; });
    const dispatcher = new OutboxDispatcher({
      outbox,
      pollIntervalMs: 60_000,
      sender: {
        send: async () => {
          sendStarted?.();
          await finish;
        },
      },
    });
    try {
      dispatcher.start();
      await started;

      let stopped = false;
      const stopping = dispatcher.stop();
      expect(stopping).toBeInstanceOf(Promise);
      void (stopping as unknown as Promise<void>).then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finishSend?.();
      await (stopping as unknown as Promise<void>);

      expect(outbox.pending()).toEqual([]);
    } finally {
      finishSend?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      outbox.close();
    }
  });

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
