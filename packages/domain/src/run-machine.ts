export type AgentProvider = "claude" | "codex" | "copilot";

export type ActiveRunState =
  | "queued"
  | "independent_research"
  | "normalize_evidence"
  | "cross_review"
  | "resolve_disputes"
  | "synthesize"
  | "signoff"
  | "awaiting_approval";

export type RunState =
  | ActiveRunState
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface ResearchRun {
  readonly id: string;
  readonly topicId: string;
  readonly question: string;
  readonly state: RunState;
  readonly round: number;
  readonly coordinatorProvider: AgentProvider;
  readonly unresolved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pausedFrom?: ActiveRunState;
}

interface CreateQueuedRunInput {
  readonly id: string;
  readonly topicId: string;
  readonly question: string;
  readonly coordinatorProvider: AgentProvider;
  readonly now?: string;
}

export type RunEvent =
  | { readonly type: "START"; readonly now?: string }
  | { readonly type: "INDEPENDENT_COMPLETED"; readonly now?: string }
  | { readonly type: "NORMALIZED"; readonly now?: string }
  | { readonly type: "REVIEWED"; readonly openMediumHigh: number; readonly now?: string }
  | { readonly type: "RESOLUTION_COMPLETED"; readonly now?: string }
  | { readonly type: "SYNTHESIZED"; readonly now?: string }
  | { readonly type: "SIGNED_OFF"; readonly openMediumHigh: number; readonly now?: string }
  | { readonly type: "PAUSE"; readonly now?: string }
  | { readonly type: "RESUME"; readonly now?: string }
  | { readonly type: "CANCEL"; readonly now?: string }
  | { readonly type: "FAIL"; readonly now?: string };

export class InvalidTransitionError extends Error {
  constructor(state: RunState, event: RunEvent["type"]) {
    super(`invalid ResearchRun transition: ${state} + ${event}`);
    this.name = "InvalidTransitionError";
  }
}

export function createQueuedRun(input: CreateQueuedRunInput): ResearchRun {
  const question = input.question.trim();
  if (!question) {
    throw new Error("research question is required");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    topicId: input.topicId,
    question,
    state: "queued",
    round: 0,
    coordinatorProvider: input.coordinatorProvider,
    unresolved: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function transition(run: ResearchRun, event: RunEvent): ResearchRun {
  const now = event.now ?? new Date().toISOString();
  if (event.type === "CANCEL" && !isTerminal(run.state)) {
    return withoutPausedFrom({ ...run, state: "cancelled", updatedAt: now });
  }
  if (event.type === "FAIL" && !isTerminal(run.state)) {
    return withoutPausedFrom({ ...run, state: "failed", updatedAt: now });
  }
  if (event.type === "PAUSE" && isActive(run.state)) {
    return { ...run, state: "paused", pausedFrom: run.state, updatedAt: now };
  }
  if (event.type === "RESUME" && run.state === "paused" && run.pausedFrom !== undefined) {
    return withoutPausedFrom({ ...run, state: run.pausedFrom, updatedAt: now });
  }

  switch (run.state) {
    case "queued":
      if (event.type === "START") {
        return { ...run, state: "independent_research", round: 1, updatedAt: now };
      }
      break;
    case "independent_research":
      if (event.type === "INDEPENDENT_COMPLETED") {
        return { ...run, state: "normalize_evidence", updatedAt: now };
      }
      break;
    case "normalize_evidence":
      if (event.type === "NORMALIZED") {
        return { ...run, state: "cross_review", updatedAt: now };
      }
      break;
    case "cross_review":
      if (event.type === "REVIEWED") {
        validateOpenCount(event.openMediumHigh);
        if (event.openMediumHigh === 0) {
          return { ...run, state: "synthesize", unresolved: false, updatedAt: now };
        }
        if (run.round >= 3) {
          return { ...run, state: "synthesize", unresolved: true, updatedAt: now };
        }
        return { ...run, state: "resolve_disputes", unresolved: true, updatedAt: now };
      }
      break;
    case "resolve_disputes":
      if (event.type === "RESOLUTION_COMPLETED") {
        return {
          ...run,
          state: "cross_review",
          round: Math.min(3, run.round + 1),
          updatedAt: now,
        };
      }
      break;
    case "synthesize":
      if (event.type === "SYNTHESIZED") {
        return { ...run, state: "signoff", updatedAt: now };
      }
      break;
    case "signoff":
      if (event.type === "SIGNED_OFF") {
        validateOpenCount(event.openMediumHigh);
        if (event.openMediumHigh === 0) {
          return withoutPausedFrom({ ...run, state: "completed", updatedAt: now });
        }
        if (run.round >= 3) {
          return withoutPausedFrom({
            ...run,
            state: "completed",
            unresolved: true,
            updatedAt: now,
          });
        }
        return { ...run, state: "resolve_disputes", unresolved: true, updatedAt: now };
      }
      break;
    case "awaiting_approval":
    case "paused":
    case "completed":
    case "cancelled":
    case "failed":
      break;
    default:
      assertNever(run.state);
  }
  throw new InvalidTransitionError(run.state, event.type);
}

function isActive(state: RunState): state is ActiveRunState {
  return !isTerminal(state) && state !== "paused";
}

function isTerminal(state: RunState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function validateOpenCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("openMediumHigh must be a non-negative integer");
  }
}

function withoutPausedFrom(run: ResearchRun): ResearchRun {
  const { pausedFrom: _pausedFrom, ...rest } = run;
  return rest;
}

function assertNever(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
}
