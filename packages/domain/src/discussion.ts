import type { ProviderName } from "../../agent-adapters/src/index.js";

export type DiscussionState =
  | "active"
  | "paused"
  | "summarizing"
  | "completed"
  | "stopped"
  | "failed";

export type DiscussionAction = "pause" | "resume" | "summarize" | "stop";

export const DISCUSSION_PROVIDERS = ["claude", "codex", "copilot"] as const;

export interface GroupDiscussion {
  readonly id: string;
  readonly topicId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly question: string;
  readonly starterPrincipalId: string;
  readonly state: DiscussionState;
  readonly round: number;
  readonly turnIndex: number;
  readonly nextProvider: ProviderName;
  readonly roundOrder: readonly ProviderName[];
  readonly maxRounds: number;
  readonly version: number;
  readonly preferredProvider?: ProviderName;
  readonly controlMessageId?: string;
  readonly activeTurnId?: string;
  readonly summaryText?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDiscussionInput {
  readonly id: string;
  readonly topicId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly question: string;
  readonly starterPrincipalId: string;
  readonly maxRounds?: number;
  readonly now?: string;
}

export interface DiscussionTurnResult {
  readonly provider: ProviderName;
  readonly continueDiscussion: boolean;
  readonly now?: string;
}

const ROUND_ORDERS: readonly (readonly ProviderName[])[] = [
  ["claude", "codex", "copilot"],
  ["codex", "copilot", "claude"],
  ["copilot", "claude", "codex"],
];

export function createDiscussion(input: CreateDiscussionInput): GroupDiscussion {
  const question = input.question.trim();
  if (!question) throw new Error("Discussion question is required");
  if (!input.starterPrincipalId.trim()) throw new Error("Discussion starter is required");
  const maxRounds = input.maxRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
    throw new Error("Discussion maxRounds must be an integer from 1 to 10");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    topicId: input.topicId,
    tenantKey: input.tenantKey,
    chatId: input.chatId,
    question,
    starterPrincipalId: input.starterPrincipalId,
    state: "active",
    round: 1,
    turnIndex: 0,
    nextProvider: "claude",
    roundOrder: [...roundOrderFor(0)],
    maxRounds,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function nextDiscussionProvider(discussion: GroupDiscussion): ProviderName {
  return discussion.preferredProvider
    ?? discussion.roundOrder[discussion.turnIndex % 3]
    ?? discussion.nextProvider;
}

export function completeDiscussionTurn(
  discussion: GroupDiscussion,
  result: DiscussionTurnResult,
): GroupDiscussion {
  if (discussion.state !== "active") {
    throw new Error(`Cannot complete a turn while Discussion is ${discussion.state}`);
  }
  const expected = nextDiscussionProvider(discussion);
  if (result.provider !== expected) {
    throw new Error(`Discussion turn provider mismatch: expected ${expected}`);
  }
  const turnIndex = discussion.turnIndex + 1;
  const slot = discussion.turnIndex % 3;
  const currentRoundOrder = discussion.preferredProvider === undefined
    ? [...discussion.roundOrder]
    : [
        ...discussion.roundOrder.slice(0, slot),
        result.provider,
        ...discussion.roundOrder.slice(slot).filter((provider) => provider !== result.provider),
      ];
  const roundOrder = turnIndex % 3 === 0
    ? [...roundOrderFor(Math.floor(turnIndex / 3))]
    : currentRoundOrder;
  const {
    preferredProvider: _preferredProvider,
    activeTurnId: _activeTurnId,
    ...base
  } = discussion;
  return {
    ...base,
    turnIndex,
    round: Math.min(discussion.maxRounds, Math.floor(turnIndex / 3) + 1),
    nextProvider: roundOrder[turnIndex % 3] ?? "claude",
    roundOrder,
    version: discussion.version + 1,
    updatedAt: result.now ?? new Date().toISOString(),
  };
}

export function shouldSummarize(
  roundVotes: readonly boolean[],
  round: number,
  maxRounds: number,
): boolean {
  if (roundVotes.length !== DISCUSSION_PROVIDERS.length) return false;
  return round >= maxRounds || roundVotes.every((continueDiscussion) => !continueDiscussion);
}

export function transitionDiscussion(
  discussion: GroupDiscussion,
  action: DiscussionAction,
  now = new Date().toISOString(),
): GroupDiscussion {
  if (["completed", "stopped", "failed"].includes(discussion.state)) {
    throw new Error(`Cannot ${action} a terminal Discussion`);
  }
  const allowed: Record<DiscussionAction, readonly DiscussionState[]> = {
    pause: ["active", "summarizing"],
    resume: ["paused"],
    summarize: ["active", "paused"],
    stop: ["active", "paused", "summarizing"],
  };
  if (!allowed[action].includes(discussion.state)) {
    throw new Error(`Cannot ${action} a Discussion while it is ${discussion.state}`);
  }
  const state: DiscussionState = action === "pause"
    ? "paused"
    : action === "resume"
      ? "active"
      : action === "summarize"
        ? "summarizing"
        : "stopped";
  return { ...discussion, state, version: discussion.version + 1, updatedAt: now };
}

function roundOrderFor(roundIndex: number): readonly ProviderName[] {
  return ROUND_ORDERS[roundIndex % ROUND_ORDERS.length] ?? ROUND_ORDERS[0] ?? DISCUSSION_PROVIDERS;
}
