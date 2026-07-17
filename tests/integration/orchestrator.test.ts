import { describe, expect, it } from "vitest";

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

const providers = ["claude", "codex", "copilot"] as const;

class MemoryOrchestrationStore implements OrchestrationStore {
  readonly checkpoints = new Map<string, OrchestrationCheckpoint>();
  readonly records: OrchestrationRecord[] = [];
  crashAtCrossReview = false;

  save(checkpoint: OrchestrationCheckpoint): void {
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
}

interface FakeOptions {
  readonly failed?: readonly ProviderName[];
  readonly openCritiques?: boolean;
}

function phaseOf(prompt: string): string {
  return /^PHASE: ([^\n]+)/.exec(prompt)?.[1] ?? "unknown";
}

function report(provider: ProviderName): unknown {
  return {
    summary: `${provider} summary`,
    claims: [
      {
        id: `${provider}-claim`,
        text: `${provider} supported claim`,
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
        quote: "Primary-source quotation",
        retrievedAt: "2026-07-17T12:00:00.000Z",
      },
    ],
    openQuestions: [],
    subtaskProposals: [],
  };
}

function fakeAdapters(
  calls: Array<{ provider: ProviderName; phase: string; prompt: string }>,
  concurrency: { active: number; maximum: number },
  options: FakeOptions = {},
): AdapterRegistry {
  const make = (provider: ProviderName): AgentAdapter => {
    const invoke = async (task: AgentTask | ResumeAgentTask): Promise<AdapterResult> => {
      if (options.failed?.includes(provider)) throw new Error(`${provider} unavailable`);
      const phase = phaseOf(task.prompt);
      calls.push({ provider, phase, prompt: task.prompt });
      concurrency.active += 1;
      concurrency.maximum = Math.max(concurrency.maximum, concurrency.active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      concurrency.active -= 1;
      let output: unknown;
      if (phase === "independent_research" || phase === "synthesize") {
        output = report(provider);
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
        output = { approved: true, critiques: [] };
      } else {
        output = { resolved: true };
      }
      return {
        provider,
        externalSessionId:
          "externalSessionId" in task ? task.externalSessionId : `${provider}-session`,
        events: [{ type: "final", text: JSON.stringify(output) }],
      };
    };
    return { provider, start: invoke, resume: invoke };
  };
  return {
    claude: make("claude"),
    codex: make("codex"),
    copilot: make("copilot"),
  };
}

function createHarness(store: MemoryOrchestrationStore, options: FakeOptions = {}) {
  const calls: Array<{ provider: ProviderName; phase: string; prompt: string }> = [];
  const concurrency = { active: 0, maximum: 0 };
  return {
    calls,
    concurrency,
    orchestrator: new ResearchOrchestrator({
      adapters: fakeAdapters(calls, concurrency, options),
      store,
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
    });

    expect(result.phases).toEqual([
      "independent_research",
      "normalize_evidence",
      "cross_review",
      "synthesize",
      "signoff",
      "completed",
    ]);
    expect(result.reviews).toHaveLength(6);
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
    expect(store.records.filter((event) => event.type === "agent.call.started")).toHaveLength(12);
    expect(store.records.filter((event) => event.type === "agent.call.completed")).toHaveLength(12);
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
    expect(degradedResult.reviews).toHaveLength(2);

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
    expect(result.reviews).toHaveLength(18);
    expect(result.phases).toContain("resolve_disputes");
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
});
