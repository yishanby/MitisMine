import { describe, expect, it } from "vitest";

import { WorkerLeaseStore } from "../../apps/worker/src/main.js";
import type {
  AdapterRegistry,
  AdapterResult,
  AgentAdapter,
  AgentTask,
  ProviderName,
  ResumeAgentTask,
} from "../../packages/agent-adapters/src/index.js";
import {
  ResearchOrchestrator,
  type OrchestrationCheckpoint,
  type OrchestrationRecord,
  type OrchestrationStore,
} from "../../packages/orchestrator/src/index.js";
import {
  LocalWorkerTaskExecutor,
  type WorkerLeasePort,
  type WorkerLeaseStatus,
} from "../../packages/orchestrator/src/worker.js";

const providers = ["claude", "codex", "copilot"] as const;

class MemoryOrchestrationStore implements OrchestrationStore {
  readonly checkpoints = new Map<string, OrchestrationCheckpoint>();
  readonly records: OrchestrationRecord[] = [];
  readonly topicSessions = new Map<string, string>();
  readonly staleTerminalOverwrites: string[] = [];
  crashAtCrossReview = false;

  save(checkpoint: OrchestrationCheckpoint): void {
    const previous = this.checkpoints.get(checkpoint.run.id);
    if (
      previous?.run.state === "cancelled" &&
      checkpoint.run.state !== "cancelled"
    ) {
      this.staleTerminalOverwrites.push(checkpoint.run.state);
    }
    this.checkpoints.set(checkpoint.run.id, structuredClone(checkpoint));
    if (this.crashAtCrossReview && checkpoint.run.state === "cross_review") {
      this.crashAtCrossReview = false;
      throw new Error("simulated crash");
    }
  }

  load(runId: string): OrchestrationCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(runId);
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }

  record(event: OrchestrationRecord): void {
    this.records.push(structuredClone(event));
  }

  runCount(topicId: string): number {
    return [...this.checkpoints.values()].filter(
      (checkpoint) => checkpoint.run.topicId === topicId,
    ).length;
  }

  topicSession(topicId: string, provider: ProviderName): string | undefined {
    return this.topicSessions.get(`${topicId}:${provider}`);
  }

  saveTopicSession(topicId: string, provider: ProviderName, externalSessionId: string): void {
    this.topicSessions.set(`${topicId}:${provider}`, externalSessionId);
  }
}

class RecordingLeasePort implements WorkerLeasePort {
  readonly histories = new Map<string, WorkerLeaseStatus[]>();

  lease(taskId: string): void {
    this.#record(taskId, "leased");
  }

  heartbeat(): void {}

  complete(taskId: string): void {
    this.#record(taskId, "completed");
  }

  requeue(taskId: string): void {
    this.#record(taskId, "queued");
  }

  fail(taskId: string): void {
    this.#record(taskId, "failed");
  }

  #record(taskId: string, status: WorkerLeaseStatus): void {
    const history = this.histories.get(taskId) ?? [];
    history.push(status);
    this.histories.set(taskId, history);
  }
}

interface FakeOptions {
  readonly failed?: readonly ProviderName[];
  readonly openCritiques?: boolean;
  readonly proposeSubtasks?: boolean;
  readonly updateReportsOnResolve?: boolean;
  readonly rejectFirstSignoff?: boolean;
  readonly highCritiqueOnFirstSignoff?: boolean;
}

function phaseOf(prompt: string): string {
  return /^PHASE: ([^\n]+)/.exec(prompt)?.[1] ?? "unknown";
}

function report(
  provider: ProviderName,
  proposeSubtasks = false,
  revision: "initial" | "resolved" = "initial",
): unknown {
  return {
    summary: `${provider} ${revision} summary`,
    claims: [
      {
        id: `${provider}-claim`,
        text: `${provider} ${revision} supported claim`,
        importance: "important",
        confidence: 0.9,
        evidenceIds: [`${provider}-evidence`],
      },
    ],
    evidence: [
      {
        id: `${provider}-evidence`,
        url: `https://example.com/${provider}`,
        title: `${provider} source`,
        publisher: "Example",
        quote: revision === "resolved"
          ? "New quotation gathered during dispute resolution"
          : "Primary-source quotation",
        retrievedAt: "2026-07-17T12:00:00.000Z",
      },
    ],
    openQuestions: [],
    subtaskProposals: proposeSubtasks
      ? [
          { id: `${provider}-sub-1`, title: "Check source", prompt: "Check source one" },
          { id: `${provider}-sub-2`, title: "Check counterpoint", prompt: "Check source two" },
        ]
      : [],
  };
}

function fakeAdapters(
  calls: Array<{
    provider: ProviderName;
    phase: string;
    prompt: string;
    runId: string;
    method: "start" | "resume";
    externalSessionId?: string;
    resultExternalSessionId: string;
  }>,
  concurrency: { active: number; maximum: number },
  options: FakeOptions = {},
): AdapterRegistry {
  const make = (provider: ProviderName): AgentAdapter => {
    let startedSessions = 0;
    let signoffCalls = 0;
    const invoke = async (
      task: AgentTask | ResumeAgentTask,
      method: "start" | "resume",
    ): Promise<AdapterResult> => {
      if (options.failed?.includes(provider)) throw new Error(`${provider} unavailable`);
      const phase = phaseOf(task.prompt);
      const resultExternalSessionId = "externalSessionId" in task
        ? task.externalSessionId
        : `${provider}-session-${++startedSessions}`;
      calls.push({
        provider,
        phase,
        prompt: task.prompt,
        runId: task.runId,
        method,
        ...(method === "resume" && "externalSessionId" in task
          ? { externalSessionId: task.externalSessionId }
          : {}),
        resultExternalSessionId,
      });
      concurrency.active += 1;
      concurrency.maximum = Math.max(concurrency.maximum, concurrency.active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      concurrency.active -= 1;
      let output: unknown;
      if (phase === "independent_research" || phase === "synthesize") {
        output = report(provider, phase === "independent_research" && options.proposeSubtasks);
      } else if (phase === "cross_review") {
        output = {
          critiques: options.openCritiques
            ? [
                {
                  targetClaimId: "claim",
                  severity: "high",
                  text: "Needs stronger evidence",
                  status: "open",
                },
              ]
            : [],
        };
      } else if (phase === "signoff") {
        signoffCalls += 1;
        if (options.rejectFirstSignoff && signoffCalls === 1) {
          output = { approved: false, critiques: [] };
        } else if (options.highCritiqueOnFirstSignoff && signoffCalls === 1) {
          output = {
            approved: true,
            critiques: [{
              targetClaimId: `${provider}-claim`,
              severity: "high",
              text: "Signoff-only blocking concern",
              status: "open",
            }],
          };
        } else {
          output = { approved: true, critiques: [] };
        }
      } else if (phase === "resolve_disputes") {
        output = report(
          provider,
          false,
          options.updateReportsOnResolve ? "resolved" : "initial",
        );
      } else {
        output = {};
      }
      return {
        provider,
        externalSessionId: resultExternalSessionId,
        events: [{ type: "final", text: JSON.stringify(output) }],
      };
    };
    return {
      provider,
      start: (task) => invoke(task, "start"),
      resume: (task) => invoke(task, "resume"),
    };
  };
  return {
    claude: make("claude"),
    codex: make("codex"),
    copilot: make("copilot"),
  };
}

function createHarness(store: MemoryOrchestrationStore, options: FakeOptions = {}) {
  const calls: Array<{
    provider: ProviderName;
    phase: string;
    prompt: string;
    runId: string;
    method: "start" | "resume";
    externalSessionId?: string;
    resultExternalSessionId: string;
  }> = [];
  const concurrency = { active: 0, maximum: 0 };
  const leases = new RecordingLeasePort();
  return {
    calls,
    concurrency,
    leases,
    orchestrator: new ResearchOrchestrator({
      adapters: fakeAdapters(calls, concurrency, options),
      store,
      worker: new LocalWorkerTaskExecutor({ leases }),
      maxConcurrency: 6,
    }),
  };
}

describe("ResearchOrchestrator", () => {
  it("fans out independently, cross-reviews all pairs, synthesizes and signs off", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store);

    const result = await harness.orchestrator.start({
      runId: "run-normal",
      topicId: "topic-1",
      question: "question",
      cwd: process.cwd(),
      contextPack: '{"watermark":7,"events":[]}',
    });

    expect(result.phases).toEqual([
      "independent_research",
      "normalize_evidence",
      "cross_review",
      "synthesize",
      "signoff",
      "completed",
    ]);
    expect(result.reviews.filter((review) => review.approved === undefined)).toHaveLength(6);
    expect(result.reviews.filter((review) => review.approved === true)).toHaveLength(2);
    expect(
      result.report?.claims.every(
        (claim) => claim.evidenceIds.length > 0 || claim.status === "unsupported",
      ),
    ).toBe(true);
    expect(harness.concurrency.maximum).toBeLessThanOrEqual(6);
    expect(
      harness.calls
        .filter((call) => call.phase === "independent_research")
        .every((call) => !call.prompt.includes("PEER_REPORT")),
    ).toBe(true);
    expect(
      harness.calls
        .filter((call) => call.phase === "independent_research")
        .every((call) => call.prompt.includes("id, title, and prompt")),
    ).toBe(true);
    expect(
      harness.calls
        .filter((call) => call.phase === "independent_research")
        .every((call) => call.prompt.includes('CONTEXT_PACK: {"watermark":7,"events":[]}')),
    ).toBe(true);
    expect(store.records.filter((event) => event.type === "agent.call.started")).toHaveLength(12);
    expect(store.records.filter((event) => event.type === "agent.call.completed")).toHaveLength(12);
    expect(harness.leases.histories.size).toBe(harness.calls.length);
    expect([...harness.leases.histories.values()].every(
      (history) => history.join(",") === "leased,completed",
    )).toBe(true);
    expect([...harness.leases.histories.keys()].every(
      (taskId) => /^run-normal:(claude|codex|copilot):[a-z_]+:(?:main|[^:]+):[0-9a-f]{64}$/.test(taskId),
    )).toBe(true);
    const crossReviewTaskIds = [...harness.leases.histories.keys()].filter(
      (taskId) => taskId.includes(":cross_review:"),
    );
    expect(crossReviewTaskIds).toHaveLength(6);
    expect(new Set(crossReviewTaskIds).size).toBe(6);
  });

  it("resumes from a durable review checkpoint without repeating independent research", async () => {
    const store = new MemoryOrchestrationStore();
    store.crashAtCrossReview = true;
    const first = createHarness(store);
    await expect(
      first.orchestrator.start({
        runId: "run-restart",
        topicId: "topic-1",
        question: "question",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("simulated crash");

    const second = createHarness(store);
    const result = await second.orchestrator.resume("run-restart");

    expect(result.run.state).toBe("completed");
    expect(first.calls.filter((call) => call.phase === "independent_research")).toHaveLength(3);
    expect(second.calls.filter((call) => call.phase === "independent_research")).toHaveLength(0);
  });

  it("completes with two providers but pauses when fewer than two succeed", async () => {
    const degradedStore = new MemoryOrchestrationStore();
    const degraded = createHarness(degradedStore, { failed: ["copilot"] });
    const degradedResult = await degraded.orchestrator.start({
      runId: "run-degraded",
      topicId: "topic-1",
      question: "question",
      cwd: process.cwd(),
    });
    expect(degradedResult.run.state).toBe("completed");
    expect(degradedResult.degradedProviders).toEqual(["copilot"]);
    expect(degradedResult.reviews.filter((review) => review.approved === undefined)).toHaveLength(2);
    expect(degradedResult.reviews.filter((review) => review.approved === true)).toHaveLength(1);

    const pausedStore = new MemoryOrchestrationStore();
    const paused = createHarness(pausedStore, { failed: ["codex", "copilot"] });
    const pausedResult = await paused.orchestrator.start({
      runId: "run-paused",
      topicId: "topic-1",
      question: "question",
      cwd: process.cwd(),
    });
    expect(pausedResult.run.state).toBe("paused");
    expect(pausedResult.report).toBeUndefined();
  });

  it("stops targeted dispute research after round three and exposes unresolved status", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store, { openCritiques: true });

    const result = await harness.orchestrator.start({
      runId: "run-disputed",
      topicId: "topic-1",
      question: "question",
      cwd: process.cwd(),
    });

    expect(result.run.state).toBe("completed");
    expect(result.run.round).toBe(3);
    expect(result.run.unresolved).toBe(true);
    expect(result.reviews.filter((review) => review.approved === undefined)).toHaveLength(18);
    expect(result.reviews.filter((review) => review.approved === true)).toHaveLength(2);
    expect(result.phases).toContain("resolve_disputes");
  });

  it("normalizes resolved reports and reviews their updated claims and evidence next", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store, { openCritiques: true, updateReportsOnResolve: true });

    const result = await harness.orchestrator.start({
      runId: "run-resolution-report",
      topicId: "topic-resolution-report",
      question: "question",
      cwd: process.cwd(),
    });

    expect(result.reports.claude?.claims[0]?.text).toContain("resolved supported claim");
    expect(result.reports.claude?.evidence[0]?.quote).toContain("New quotation");
    expect(harness.calls.filter((call) => call.phase === "resolve_disputes").every(
      (call) => call.prompt.includes("CURRENT_REPORT:") && call.prompt.includes("OPEN_CRITIQUES:"),
    )).toBe(true);
    expect(harness.calls.some(
      (call) => call.phase === "cross_review" && call.prompt.includes("resolved supported claim"),
    )).toBe(true);
  });

  it("turns an unqualified approved=false signoff into a blocking high critique", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store, { rejectFirstSignoff: true });

    const result = await harness.orchestrator.start({
      runId: "run-signoff-rejected",
      topicId: "topic-signoff-rejected",
      question: "question",
      cwd: process.cwd(),
    });

    expect(result.run.round).toBe(2);
    expect(result.reviews.some((review) =>
      review.approved === false && review.critiques.some((critique) =>
        critique.severity === "high" && critique.status === "open"
      )
    )).toBe(true);
  });

  it("persists a signoff-only high critique and includes it in the next resolution prompt", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store, { highCritiqueOnFirstSignoff: true });

    const result = await harness.orchestrator.start({
      runId: "run-signoff-critique",
      topicId: "topic-signoff-critique",
      question: "question",
      cwd: process.cwd(),
    });

    expect(result.reviews.some((review) => review.critiques.some(
      (critique) => critique.text === "Signoff-only blocking concern",
    ))).toBe(true);
    expect(harness.calls.some(
      (call) => call.phase === "resolve_disputes" &&
        call.prompt.includes("Signoff-only blocking concern"),
    )).toBe(true);
  });

  it("rotates the synthesis provider between Topic runs", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store);
    const first = await harness.orchestrator.start({
      runId: "run-1",
      topicId: "topic-rotation",
      question: "one",
      cwd: process.cwd(),
    });
    const second = await harness.orchestrator.start({
      runId: "run-2",
      topicId: "topic-rotation",
      question: "two",
      cwd: process.cwd(),
    });

    expect(first.run.coordinatorProvider).toBe(providers[0]);
    expect(second.run.coordinatorProvider).toBe(providers[1]);
  });

  it("resumes each provider research session across Runs in the same Topic", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store);
    await harness.orchestrator.start({
      runId: "run-session-1",
      topicId: "topic-session",
      question: "one",
      cwd: process.cwd(),
    });
    const firstSessions = Object.fromEntries(
      providers.map((provider) => [provider, store.topicSession("topic-session", provider)]),
    );

    await harness.orchestrator.start({
      runId: "run-session-2",
      topicId: "topic-session",
      question: "two",
      cwd: process.cwd(),
    });

    const secondIndependent = harness.calls.filter(
      (call) => call.runId === "run-session-2" && call.phase === "independent_research",
    );
    expect(secondIndependent).toHaveLength(3);
    expect(secondIndependent).toEqual(expect.arrayContaining(
      providers.map((provider) => expect.objectContaining({
        provider,
        method: "resume",
        externalSessionId: firstSessions[provider],
      })),
    ));
  });

  it("coalesces recovery with an already-running Run", async () => {
    const store = new MemoryOrchestrationStore();
    let startedCount = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: Parameters<typeof fakeAdapters>[0] = [];
    const baseAdapters = fakeAdapters(calls, { active: 0, maximum: 0 });
    const waiting = (provider: ProviderName): AgentAdapter => {
      const invoke = async (
        task: AgentTask | ResumeAgentTask,
        method: "start" | "resume",
      ): Promise<AdapterResult> => {
        if (phaseOf(task.prompt) === "independent_research") {
          startedCount += 1;
          if (startedCount === providers.length) markStarted?.();
          await blocked;
        }
        return baseAdapters[provider][method](task as never);
      };
      return {
        provider,
        start: (task) => invoke(task, "start"),
        resume: (task) => invoke(task, "resume"),
      };
    };
    const orchestrator = new ResearchOrchestrator({
      store,
      adapters: {
        claude: waiting("claude"),
        codex: waiting("codex"),
        copilot: waiting("copilot"),
      },
      worker: new LocalWorkerTaskExecutor({ leases: new RecordingLeasePort() }),
    });

    const running = orchestrator.start({
      runId: "run-coalesced",
      topicId: "topic-coalesced",
      question: "question",
      cwd: process.cwd(),
    });
    await started;
    const recovered = orchestrator.resume("run-coalesced");
    await Promise.resolve();
    expect(startedCount).toBe(3);

    release?.();
    const [first, second] = await Promise.all([running, recovered]);
    expect(first).toEqual(second);
    expect(first.run.state).toBe("completed");
  });

  it("keeps cancellation terminal when providers ignore abort and return late", async () => {
    const store = new MemoryOrchestrationStore();
    let startedCount = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseLate: (() => void) | undefined;
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    const waiting = (provider: ProviderName): AgentAdapter => {
      const invoke = async (_task: AgentTask | ResumeAgentTask): Promise<AdapterResult> => {
        startedCount += 1;
        if (startedCount === providers.length) markStarted?.();
        await late;
        return {
          provider,
          externalSessionId: `${provider}-late`,
          events: [{ type: "final", text: JSON.stringify(report(provider)) }],
        };
      };
      return { provider, start: invoke, resume: invoke };
    };
    const orchestrator = new ResearchOrchestrator({
      store,
      adapters: {
        claude: waiting("claude"),
        codex: waiting("codex"),
        copilot: waiting("copilot"),
      },
      worker: new LocalWorkerTaskExecutor({ leases: new RecordingLeasePort() }),
    });
    const running = orchestrator.start({
      runId: "run-cancel",
      topicId: "topic-1",
      question: "question",
      cwd: process.cwd(),
    });
    await started;

    await orchestrator.cancel("run-cancel");
    releaseLate?.();
    const result = await running;

    expect(result.run.state).toBe("cancelled");
    expect(store.load("run-cancel")?.run.state).toBe("cancelled");
    expect(store.staleTerminalOverwrites).toEqual([]);
  });

  it("requeues expired work and resumes with the same deterministic task IDs", async () => {
    const store = new MemoryOrchestrationStore();
    store.crashAtCrossReview = true;
    const initial = createHarness(store);
    await expect(initial.orchestrator.start({
      runId: "run-worker-restart",
      topicId: "topic-worker-restart",
      question: "question",
      cwd: process.cwd(),
    })).rejects.toThrow("simulated crash");

    const leases = WorkerLeaseStore.open(":memory:");
    const droppedTaskIds: string[] = [];
    const droppedCalls: Parameters<typeof fakeAdapters>[0] = [];
    const dropped = new ResearchOrchestrator({
      store,
      adapters: fakeAdapters(droppedCalls, { active: 0, maximum: 0 }),
      worker: {
        execute: async (input) => {
          droppedTaskIds.push(input.taskId);
          leases.lease(
            input.taskId,
            "dropped-worker",
            new Date("2026-07-17T12:00:00.000Z"),
            1_000,
          );
          throw new Error("worker process dropped");
        },
      },
    });

    try {
      await expect(dropped.resume("run-worker-restart")).rejects.toThrow("worker process dropped");
      expect(droppedTaskIds.length).toBeGreaterThan(0);
      expect(droppedTaskIds.every((taskId) => leases.status(taskId) === "leased")).toBe(true);
      expect(leases.requeueExpired(new Date("2026-07-17T12:00:02.000Z")))
        .toEqual([...droppedTaskIds].sort());

      const resumedCalls: Parameters<typeof fakeAdapters>[0] = [];
      const resumed = new ResearchOrchestrator({
        store,
        adapters: fakeAdapters(resumedCalls, { active: 0, maximum: 0 }),
        worker: new LocalWorkerTaskExecutor({
          leases,
          now: () => new Date("2026-07-17T12:00:02.000Z"),
        }),
      });
      const result = await resumed.resume("run-worker-restart");

      expect(result.run.state).toBe("completed");
      for (const taskId of droppedTaskIds) {
        expect(leases.history(taskId)).toEqual(["leased", "queued", "leased", "completed"]);
      }
    } finally {
      leases.close();
    }
  });

  it("executes at most two proposed subtasks per provider under the global semaphore", async () => {
    const store = new MemoryOrchestrationStore();
    const harness = createHarness(store, { proposeSubtasks: true });
    const result = await harness.orchestrator.start({
      runId: "run-subtasks",
      topicId: "topic-subtasks",
      question: "question",
      cwd: process.cwd(),
    });

    const subtaskCalls = harness.calls.filter((call) => call.phase === "subtask_research");
    expect(subtaskCalls).toHaveLength(6);
    expect(subtaskCalls.every((call) => call.method === "start")).toBe(true);
    expect(new Set(subtaskCalls.map((call) => call.resultExternalSessionId)).size).toBe(6);
    for (const call of subtaskCalls) {
      expect(call.resultExternalSessionId).not.toBe(store.topicSession("topic-subtasks", call.provider));
    }
    expect(Object.values(result.subtaskResults).flat()).toHaveLength(6);
    expect(result.sessions).toEqual(Object.fromEntries(
      providers.map((provider) => [provider, store.topicSession("topic-subtasks", provider)]),
    ));
    expect(Object.values(store.load("run-subtasks")?.subtaskSessions ?? {}).flatMap(
      (sessions) => Object.values(sessions),
    )).toHaveLength(6);
    expect(harness.concurrency.maximum).toBeLessThanOrEqual(6);
  });
});
