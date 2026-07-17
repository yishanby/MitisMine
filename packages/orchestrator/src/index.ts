import { createHash } from "node:crypto";

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
  subtaskResearchPrompt,
} from "./prompts.js";
import type { WorkerTaskExecutorPort } from "./worker.js";

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
  approved?: boolean;
  critiques: Critique[];
}

export interface SubtaskResult {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export type OrchestrationPhase = RunState | "subtask_research";

export interface OrchestrationCheckpoint {
  run: ResearchRun;
  cwd: string;
  phases: RunState[];
  reports: Partial<Record<ProviderName, NormalizedReport>>;
  sessions: Partial<Record<ProviderName, string>>;
  reviews: ResearchReview[];
  degradedProviders: ProviderName[];
  contextPack?: string;
  subtaskSessions?: Partial<Record<ProviderName, Record<string, string>>>;
  subtaskResults?: Partial<Record<ProviderName, SubtaskResult[]>>;
  report?: NormalizedReport;
}

export interface OrchestrationRecord {
  readonly runId: string;
  readonly topicId: string;
  readonly type: "agent.call.started" | "agent.call.completed" | "agent.call.failed";
  readonly provider: ProviderName;
  readonly phase: OrchestrationPhase;
  readonly createdAt: string;
}

export interface OrchestrationStore {
  save(checkpoint: OrchestrationCheckpoint): void;
  load(runId: string): OrchestrationCheckpoint | undefined;
  record(event: OrchestrationRecord): void;
  runCount(topicId: string): number;
  topicSession(topicId: string, provider: ProviderName): string | undefined;
  saveTopicSession(topicId: string, provider: ProviderName, externalSessionId: string): void;
}

export interface StartResearchInput {
  readonly runId: string;
  readonly topicId: string;
  readonly question: string;
  readonly cwd: string;
  readonly contextPack?: string;
}

export interface ResearchResult {
  readonly run: ResearchRun;
  readonly phases: readonly RunState[];
  readonly reports: Readonly<Partial<Record<ProviderName, NormalizedReport>>>;
  readonly sessions: Readonly<Partial<Record<ProviderName, string>>>;
  readonly reviews: readonly ResearchReview[];
  readonly degradedProviders: readonly ProviderName[];
  readonly subtaskResults: Readonly<Partial<Record<ProviderName, readonly SubtaskResult[]>>>;
  readonly report?: NormalizedReport;
}

interface OrchestratorOptions {
  readonly adapters: AdapterRegistry;
  readonly store: OrchestrationStore;
  readonly worker: WorkerTaskExecutorPort;
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
  readonly #worker: WorkerTaskExecutorPort;
  readonly #semaphore: Semaphore;
  readonly #controllers = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.#adapters = options.adapters;
    this.#store = options.store;
    this.#worker = options.worker;
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
      sessions: Object.fromEntries(
        PROVIDERS.flatMap((provider) => {
          const externalSessionId = this.#store.topicSession(input.topicId, provider);
          return externalSessionId === undefined ? [] : [[provider, externalSessionId]];
        }),
      ),
      reviews: [],
      degradedProviders: [],
      ...(input.contextPack === undefined ? {} : { contextPack: input.contextPack }),
      subtaskResults: {},
    };
    this.#save(checkpoint);
    return this.#run(checkpoint);
  }

  async resume(runId: string): Promise<ResearchResult> {
    const checkpoint = this.#store.load(runId);
    if (checkpoint === undefined) throw new Error(`ResearchRun not found: ${runId}`);
    return this.#run(checkpoint);
  }

  async cancel(runId: string): Promise<void> {
    const checkpoint = this.#store.load(runId);
    if (checkpoint === undefined) throw new Error(`ResearchRun not found: ${runId}`);
    if (["completed", "cancelled", "failed"].includes(checkpoint.run.state)) return;
    this.#cancelled.add(runId);
    this.#controllers.get(runId)?.abort();
    checkpoint.run = transition(checkpoint.run, { type: "CANCEL" });
    this.#phase(checkpoint, "cancelled");
    this.#save(checkpoint);
  }

  async #run(checkpoint: OrchestrationCheckpoint): Promise<ResearchResult> {
    const controller = new AbortController();
    this.#controllers.set(checkpoint.run.id, controller);
    try {
      return await this.#execute(checkpoint, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !this.#cancelled.has(checkpoint.run.id)) throw error;
      if (!["completed", "cancelled", "failed"].includes(checkpoint.run.state)) {
        checkpoint.run = transition(checkpoint.run, { type: "CANCEL" });
      }
      this.#phase(checkpoint, "cancelled");
      this.#save(checkpoint);
      return this.#result(checkpoint);
    } finally {
      this.#controllers.delete(checkpoint.run.id);
      this.#cancelled.delete(checkpoint.run.id);
    }
  }

  async #execute(checkpoint: OrchestrationCheckpoint, signal: AbortSignal): Promise<ResearchResult> {
    while (checkpoint.run.state !== "completed" && checkpoint.run.state !== "paused") {
      switch (checkpoint.run.state) {
        case "queued":
          checkpoint.run = transition(checkpoint.run, { type: "START" });
          this.#phase(checkpoint, "independent_research");
          this.#save(checkpoint);
          break;
        case "independent_research":
          await this.#independent(checkpoint);
          throwIfAborted(signal);
          await this.#subtasks(checkpoint);
          throwIfAborted(signal);
          if (successfulProviders(checkpoint).length < 2) {
            checkpoint.run = transition(checkpoint.run, { type: "PAUSE" });
            this.#phase(checkpoint, "paused");
          } else {
            checkpoint.run = transition(checkpoint.run, { type: "INDEPENDENT_COMPLETED" });
            this.#phase(checkpoint, "normalize_evidence");
          }
          this.#save(checkpoint);
          break;
        case "normalize_evidence":
          checkpoint.run = transition(checkpoint.run, { type: "NORMALIZED" });
          this.#phase(checkpoint, "cross_review");
          this.#save(checkpoint);
          break;
        case "cross_review": {
          const reviews = await this.#crossReview(checkpoint);
          throwIfAborted(signal);
          checkpoint.reviews.push(...reviews);
          const open = countOpen(reviews);
          checkpoint.run = transition(checkpoint.run, {
            type: "REVIEWED",
            openMediumHigh: open,
          });
          this.#phase(checkpoint, checkpoint.run.state);
          this.#save(checkpoint);
          break;
        }
        case "resolve_disputes":
          await this.#resolveDisputes(checkpoint);
          throwIfAborted(signal);
          checkpoint.run = transition(checkpoint.run, { type: "RESOLUTION_COMPLETED" });
          this.#phase(checkpoint, "cross_review");
          this.#save(checkpoint);
          break;
        case "synthesize":
          await this.#synthesize(checkpoint);
          throwIfAborted(signal);
          checkpoint.run = transition(checkpoint.run, { type: "SYNTHESIZED" });
          this.#phase(checkpoint, "signoff");
          this.#save(checkpoint);
          break;
        case "signoff": {
          const reviews = await this.#signoff(checkpoint);
          throwIfAborted(signal);
          checkpoint.reviews.push(...reviews);
          checkpoint.run = transition(checkpoint.run, {
            type: "SIGNED_OFF",
            openMediumHigh: countOpen(reviews),
          });
          this.#phase(checkpoint, checkpoint.run.state);
          this.#save(checkpoint);
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
            independentResearchPrompt(
              checkpoint.run.question,
              provider,
              checkpoint.contextPack ?? '{"watermark":0,"summary":"","evidence":[],"events":[]}',
            ),
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
          this.#save(checkpoint);
        } catch {
          if (!checkpoint.degradedProviders.includes(provider)) {
            checkpoint.degradedProviders.push(provider);
          }
          this.#save(checkpoint);
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

  async #subtasks(checkpoint: OrchestrationCheckpoint): Promise<void> {
    const subtaskResults = checkpoint.subtaskResults ?? (checkpoint.subtaskResults = {});
    await Promise.all(
      successfulProviders(checkpoint).map(async (provider) => {
        const report = checkpoint.reports[provider];
        if (report === undefined) return;
        const results: SubtaskResult[] = [];
        for (const proposal of report.subtaskProposals.slice(0, 2)) {
          const response = await this.#invoke(
            checkpoint,
            provider,
            "subtask_research",
            subtaskResearchPrompt({ provider, ...proposal }),
            proposal.id,
          );
          results.push({ id: proposal.id, title: proposal.title, text: finalText(response) });
          subtaskResults[provider] = results;
          this.#save(checkpoint);
        }
      }),
    );
  }

  async #resolveDisputes(checkpoint: OrchestrationCheckpoint): Promise<void> {
    const open = checkpoint.reviews.filter((review) => countOpen([review]) > 0);
    const resolved = await Promise.all(
      successfulProviders(checkpoint).map(async (provider) => {
        const report = checkpoint.reports[provider];
        if (report === undefined) throw new Error(`Missing report for ${provider}`);
        const result = await this.#invoke(
          checkpoint,
          provider,
          "resolve_disputes",
          disputeResolutionPrompt(provider, report, open, checkpoint.run.round),
        );
        return [provider, parseReport(finalText(result))] as const;
      }),
    );
    for (const [provider, report] of resolved) checkpoint.reports[provider] = report;
    this.#save(checkpoint);
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
        checkpoint.subtaskResults ?? {},
        checkpoint.reviews,
        checkpoint.run.unresolved,
      ),
    );
    checkpoint.report = parseReport(finalText(result));
  }

  async #signoff(checkpoint: OrchestrationCheckpoint): Promise<ResearchReview[]> {
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
        const parsed = signoffSchema.parse(parseJson(finalText(result)));
        const critiques = [...parsed.critiques];
        if (!parsed.approved && countOpenCritiques(critiques) === 0) {
          critiques.push({
            targetClaimId: checkpoint.report?.claims[0]?.id ?? "final-report",
            severity: "high",
            text: "Signoff rejected without a blocking critique; approval is required before completion",
            status: "open",
          });
        }
        return {
          reviewer: provider,
          target: checkpoint.run.coordinatorProvider,
          round: checkpoint.run.round,
          approved: parsed.approved,
          critiques,
        };
      }),
    );
    return results;
  }

  async #invoke(
    checkpoint: OrchestrationCheckpoint,
    provider: ProviderName,
    phase: OrchestrationPhase,
    prompt: string,
    subtaskId?: string,
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
      const activeSignal = this.#controllers.get(checkpoint.run.id)?.signal;
      const taskId = workerTaskId({
        runId: checkpoint.run.id,
        provider,
        phase,
        prompt,
        ...(subtaskId === undefined ? {} : { subtaskId }),
      });
      const result = await this.#semaphore.run(() => this.#worker.execute({
        taskId,
        ...(activeSignal === undefined ? {} : { signal: activeSignal }),
        operation: () => {
        const externalSessionId = subtaskId === undefined
          ? checkpoint.sessions[provider]
          : checkpoint.subtaskSessions?.[provider]?.[subtaskId];
        const task = {
          topicId: checkpoint.run.topicId,
          runId: checkpoint.run.id,
          prompt,
          cwd: checkpoint.cwd,
          ...(activeSignal === undefined ? {} : { signal: activeSignal }),
        };
        return externalSessionId === undefined
          ? this.#adapters[provider].start(task)
          : this.#adapters[provider].resume({ ...task, externalSessionId });
        },
      }));
      if (subtaskId === undefined) {
        checkpoint.sessions[provider] = result.externalSessionId;
        this.#store.saveTopicSession(
          checkpoint.run.topicId,
          provider,
          result.externalSessionId,
        );
      } else {
        const sessions = checkpoint.subtaskSessions ?? (checkpoint.subtaskSessions = {});
        const providerSessions = sessions[provider] ?? (sessions[provider] = {});
        providerSessions[subtaskId] = result.externalSessionId;
      }
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

  #save(checkpoint: OrchestrationCheckpoint): void {
    const persisted = this.#store.load(checkpoint.run.id);
    if (
      persisted !== undefined &&
      isTerminalState(persisted.run.state) &&
      persisted.run.state !== checkpoint.run.state
    ) {
      checkpoint.run = persisted.run;
      return;
    }
    this.#store.save(checkpoint);
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
      subtaskResults: checkpoint.subtaskResults ?? {},
      ...(checkpoint.report === undefined ? {} : { report: checkpoint.report }),
    };
  }
}

export function workerTaskId(input: {
  readonly runId: string;
  readonly provider: ProviderName;
  readonly phase: OrchestrationPhase;
  readonly prompt: string;
  readonly subtaskId?: string;
}): string {
  const promptHash = createHash("sha256").update(input.prompt, "utf8").digest("hex");
  return [
    input.runId,
    input.provider,
    input.phase,
    input.subtaskId ?? "main",
    promptHash,
  ].join(":");
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("ResearchRun cancelled");
}

function isTerminalState(state: RunState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}
