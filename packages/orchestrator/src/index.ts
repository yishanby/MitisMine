import { z } from "zod";

import type {
  AdapterRegistry,
  AdapterResult,
  ProviderName,
} from "../../agent-adapters/src/index.js";
import {
  normalizeReport,
  type AgentReportInput,
  type NormalizedReport,
} from "../../domain/src/evidence.js";
import {
  createQueuedRun,
  transition,
  type ResearchRun,
  type RunState,
} from "../../domain/src/run-machine.js";
import {
  crossReviewPrompt,
  disputeResolutionPrompt,
  independentResearchPrompt,
  repairReportPrompt,
  signoffPrompt,
  synthesisPrompt,
} from "./prompts.js";

const PROVIDERS = ["claude", "codex", "copilot"] as const;

const critiqueSchema = z.object({
  targetClaimId: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  text: z.string().min(1),
  status: z.enum(["open", "resolved"]),
});
const reviewSchema = z.object({ critiques: z.array(critiqueSchema) });
const signoffSchema = z.object({
  approved: z.boolean(),
  critiques: z.array(critiqueSchema),
});

type Critique = z.output<typeof critiqueSchema>;

export interface ResearchReview {
  reviewer: ProviderName;
  target: ProviderName;
  round: number;
  critiques: Critique[];
}

export interface OrchestrationCheckpoint {
  run: ResearchRun;
  cwd: string;
  phases: RunState[];
  reports: Partial<Record<ProviderName, NormalizedReport>>;
  sessions: Partial<Record<ProviderName, string>>;
  reviews: ResearchReview[];
  degradedProviders: ProviderName[];
  report?: NormalizedReport;
}

export interface OrchestrationRecord {
  readonly runId: string;
  readonly topicId: string;
  readonly type: "agent.call.started" | "agent.call.completed" | "agent.call.failed";
  readonly provider: ProviderName;
  readonly phase: RunState;
  readonly createdAt: string;
}

export interface OrchestrationStore {
  save(checkpoint: OrchestrationCheckpoint): void;
  load(runId: string): OrchestrationCheckpoint | undefined;
  record(event: OrchestrationRecord): void;
  runCount(topicId: string): number;
}

export interface StartResearchInput {
  readonly runId: string;
  readonly topicId: string;
  readonly question: string;
  readonly cwd: string;
}

export interface ResearchResult {
  readonly run: ResearchRun;
  readonly phases: readonly RunState[];
  readonly reports: Readonly<Partial<Record<ProviderName, NormalizedReport>>>;
  readonly sessions: Readonly<Partial<Record<ProviderName, string>>>;
  readonly reviews: readonly ResearchReview[];
  readonly degradedProviders: readonly ProviderName[];
  readonly report?: NormalizedReport;
}

interface OrchestratorOptions {
  readonly adapters: AdapterRegistry;
  readonly store: OrchestrationStore;
  readonly maxConcurrency?: number;
}

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("maxConcurrency must be positive");
    this.#limit = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

export class ResearchOrchestrator {
  readonly #adapters: AdapterRegistry;
  readonly #store: OrchestrationStore;
  readonly #semaphore: Semaphore;

  constructor(options: OrchestratorOptions) {
    this.#adapters = options.adapters;
    this.#store = options.store;
    this.#semaphore = new Semaphore(options.maxConcurrency ?? 6);
  }

  async start(input: StartResearchInput): Promise<ResearchResult> {
    if (this.#store.load(input.runId) !== undefined) {
      throw new Error(`ResearchRun already exists: ${input.runId}`);
    }
    const coordinatorIndex = this.#store.runCount(input.topicId) % PROVIDERS.length;
    const checkpoint: OrchestrationCheckpoint = {
      run: createQueuedRun({
        id: input.runId,
        topicId: input.topicId,
        question: input.question,
        coordinatorProvider: PROVIDERS[coordinatorIndex] ?? "claude",
      }),
      cwd: input.cwd,
      phases: [],
      reports: {},
      sessions: {},
      reviews: [],
      degradedProviders: [],
    };
    this.#store.save(checkpoint);
    return this.#execute(checkpoint);
  }

  async resume(runId: string): Promise<ResearchResult> {
    const checkpoint = this.#store.load(runId);
    if (checkpoint === undefined) throw new Error(`ResearchRun not found: ${runId}`);
    return this.#execute(checkpoint);
  }

  async #execute(checkpoint: OrchestrationCheckpoint): Promise<ResearchResult> {
    while (checkpoint.run.state !== "completed" && checkpoint.run.state !== "paused") {
      switch (checkpoint.run.state) {
        case "queued":
          checkpoint.run = transition(checkpoint.run, { type: "START" });
          this.#phase(checkpoint, "independent_research");
          this.#store.save(checkpoint);
          break;
        case "independent_research":
          await this.#independent(checkpoint);
          if (successfulProviders(checkpoint).length < 2) {
            checkpoint.run = transition(checkpoint.run, { type: "PAUSE" });
            this.#phase(checkpoint, "paused");
          } else {
            checkpoint.run = transition(checkpoint.run, { type: "INDEPENDENT_COMPLETED" });
            this.#phase(checkpoint, "normalize_evidence");
          }
          this.#store.save(checkpoint);
          break;
        case "normalize_evidence":
          checkpoint.run = transition(checkpoint.run, { type: "NORMALIZED" });
          this.#phase(checkpoint, "cross_review");
          this.#store.save(checkpoint);
          break;
        case "cross_review": {
          const reviews = await this.#crossReview(checkpoint);
          checkpoint.reviews.push(...reviews);
          const open = countOpen(reviews);
          checkpoint.run = transition(checkpoint.run, {
            type: "REVIEWED",
            openMediumHigh: open,
          });
          this.#phase(checkpoint, checkpoint.run.state);
          this.#store.save(checkpoint);
          break;
        }
        case "resolve_disputes":
          await this.#resolveDisputes(checkpoint);
          checkpoint.run = transition(checkpoint.run, { type: "RESOLUTION_COMPLETED" });
          this.#phase(checkpoint, "cross_review");
          this.#store.save(checkpoint);
          break;
        case "synthesize":
          await this.#synthesize(checkpoint);
          checkpoint.run = transition(checkpoint.run, { type: "SYNTHESIZED" });
          this.#phase(checkpoint, "signoff");
          this.#store.save(checkpoint);
          break;
        case "signoff": {
          const critiques = await this.#signoff(checkpoint);
          checkpoint.run = transition(checkpoint.run, {
            type: "SIGNED_OFF",
            openMediumHigh: countOpenCritiques(critiques),
          });
          this.#phase(checkpoint, checkpoint.run.state);
          this.#store.save(checkpoint);
          break;
        }
        case "awaiting_approval":
        case "cancelled":
        case "failed":
          return this.#result(checkpoint);
        default:
          throw new Error(`Cannot execute ResearchRun state: ${checkpoint.run.state}`);
      }
    }
    return this.#result(checkpoint);
  }

  async #independent(checkpoint: OrchestrationCheckpoint): Promise<void> {
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        try {
          const result = await this.#invoke(
            checkpoint,
            provider,
            "independent_research",
            independentResearchPrompt(checkpoint.run.question, provider),
          );
          checkpoint.sessions[provider] = result.externalSessionId;
          try {
            checkpoint.reports[provider] = parseReport(finalText(result));
          } catch {
            const repaired = await this.#invoke(
              checkpoint,
              provider,
              "normalize_evidence",
              repairReportPrompt(finalText(result)),
            );
            checkpoint.sessions[provider] = repaired.externalSessionId;
            checkpoint.reports[provider] = parseReport(finalText(repaired));
          }
          this.#store.save(checkpoint);
        } catch {
          if (!checkpoint.degradedProviders.includes(provider)) {
            checkpoint.degradedProviders.push(provider);
          }
          this.#store.save(checkpoint);
        }
      }),
    );
    checkpoint.degradedProviders.sort(
      (left, right) => PROVIDERS.indexOf(left) - PROVIDERS.indexOf(right),
    );
  }

  async #crossReview(checkpoint: OrchestrationCheckpoint): Promise<ResearchReview[]> {
    const active = successfulProviders(checkpoint);
    const groups = await Promise.all(
      active.map(async (reviewer) => {
        const reviews: ResearchReview[] = [];
        for (const target of active) {
          if (reviewer === target) continue;
          const targetReport = checkpoint.reports[target];
          if (targetReport === undefined) continue;
          const result = await this.#invoke(
            checkpoint,
            reviewer,
            "cross_review",
            crossReviewPrompt(reviewer, target, targetReport, checkpoint.run.round),
          );
          const parsed = reviewSchema.parse(parseJson(finalText(result)));
          reviews.push({ reviewer, target, round: checkpoint.run.round, critiques: parsed.critiques });
        }
        return reviews;
      }),
    );
    return groups.flat();
  }

  async #resolveDisputes(checkpoint: OrchestrationCheckpoint): Promise<void> {
    const open = checkpoint.reviews.filter((review) => countOpen([review]) > 0);
    await Promise.all(
      successfulProviders(checkpoint).map((provider) =>
        this.#invoke(
          checkpoint,
          provider,
          "resolve_disputes",
          disputeResolutionPrompt(provider, open, checkpoint.run.round),
        ),
      ),
    );
  }

  async #synthesize(checkpoint: OrchestrationCheckpoint): Promise<void> {
    const active = successfulProviders(checkpoint);
    let coordinator = checkpoint.run.coordinatorProvider;
    if (!active.includes(coordinator)) {
      coordinator = active[0] ?? coordinator;
      checkpoint.run = { ...checkpoint.run, coordinatorProvider: coordinator };
    }
    const result = await this.#invoke(
      checkpoint,
      coordinator,
      "synthesize",
      synthesisPrompt(
        checkpoint.run.question,
        checkpoint.reports,
        checkpoint.reviews,
        checkpoint.run.unresolved,
      ),
    );
    checkpoint.report = parseReport(finalText(result));
  }

  async #signoff(checkpoint: OrchestrationCheckpoint): Promise<Critique[]> {
    if (checkpoint.report === undefined) throw new Error("Cannot sign off without a report");
    const signers = successfulProviders(checkpoint).filter(
      (provider) => provider !== checkpoint.run.coordinatorProvider,
    );
    const results = await Promise.all(
      signers.map(async (provider) => {
        const result = await this.#invoke(
          checkpoint,
          provider,
          "signoff",
          signoffPrompt(checkpoint.report as NormalizedReport),
        );
        return signoffSchema.parse(parseJson(finalText(result))).critiques;
      }),
    );
    return results.flat();
  }

  async #invoke(
    checkpoint: OrchestrationCheckpoint,
    provider: ProviderName,
    phase: RunState,
    prompt: string,
  ): Promise<AdapterResult> {
    const baseRecord = {
      runId: checkpoint.run.id,
      topicId: checkpoint.run.topicId,
      provider,
      phase,
    } as const;
    this.#store.record({
      ...baseRecord,
      type: "agent.call.started",
      createdAt: new Date().toISOString(),
    });
    try {
      const result = await this.#semaphore.run(() => {
        const externalSessionId = checkpoint.sessions[provider];
        const task = {
          topicId: checkpoint.run.topicId,
          runId: checkpoint.run.id,
          prompt,
          cwd: checkpoint.cwd,
        };
        return externalSessionId === undefined
          ? this.#adapters[provider].start(task)
          : this.#adapters[provider].resume({ ...task, externalSessionId });
      });
      checkpoint.sessions[provider] = result.externalSessionId;
      this.#store.record({
        ...baseRecord,
        type: "agent.call.completed",
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.#store.record({
        ...baseRecord,
        type: "agent.call.failed",
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  #phase(checkpoint: OrchestrationCheckpoint, phase: RunState): void {
    if (!checkpoint.phases.includes(phase)) checkpoint.phases.push(phase);
  }

  #result(checkpoint: OrchestrationCheckpoint): ResearchResult {
    return {
      run: checkpoint.run,
      phases: checkpoint.phases,
      reports: checkpoint.reports,
      sessions: checkpoint.sessions,
      reviews: checkpoint.reviews,
      degradedProviders: checkpoint.degradedProviders,
      ...(checkpoint.report === undefined ? {} : { report: checkpoint.report }),
    };
  }
}

function successfulProviders(checkpoint: OrchestrationCheckpoint): ProviderName[] {
  return PROVIDERS.filter((provider) => checkpoint.reports[provider] !== undefined);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function parseReport(text: string): NormalizedReport {
  return normalizeReport(parseJson(text) as AgentReportInput);
}

function finalText(result: AdapterResult): string {
  const event = [...result.events].reverse().find(
    (candidate) => candidate.type === "final" && typeof candidate.text === "string",
  );
  if (event === undefined || typeof event.text !== "string") {
    throw new Error(`${result.provider} did not return a final response`);
  }
  return event.text;
}

function countOpen(reviews: readonly ResearchReview[]): number {
  return reviews.reduce(
    (total, review) => total + countOpenCritiques(review.critiques),
    0,
  );
}

function countOpenCritiques(critiques: readonly Critique[]): number {
  return critiques.filter(
    (critique) =>
      critique.status === "open" &&
      (critique.severity === "medium" || critique.severity === "high"),
  ).length;
}
