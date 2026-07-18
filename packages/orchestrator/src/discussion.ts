import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AdapterRegistry,
  AgentTask,
  ProviderName,
} from "../../agent-adapters/src/index.js";
import {
  completeDiscussionTurn,
  createDiscussion,
  nextDiscussionProvider,
  shouldSummarize,
  transitionDiscussion,
  type DiscussionAction,
  type GroupDiscussion,
} from "../../domain/src/discussion.js";
import { createTopic } from "../../domain/src/topic.js";
import { discussionCard, textCard } from "../../feishu/src/cards.js";
import type {
  OutboxMessage,
  OutboxPort,
  OutboxSendResult,
} from "../../storage/src/outbox.js";
import {
  type DiscussionTurn,
  SqliteDiscussionStore,
} from "../../storage/src/discussion.js";
import type { EventStore } from "../../storage/src/store.js";
import {
  AgentConcurrencyLimiter,
  type AgentCallLimiter,
} from "./concurrency.js";
import { discussionSummaryPrompt, discussionTurnPrompt } from "./prompts.js";

export interface DiscussionCoordinatorOptions {
  readonly store: SqliteDiscussionStore;
  readonly events: EventStore;
  readonly outbox: OutboxPort;
  readonly adapters: AdapterRegistry;
  readonly workspaceRoot: string;
  readonly idFactory: () => string;
  readonly maxConcurrency?: number;
  readonly limiter?: AgentCallLimiter;
}

export class DiscussionControlDeliveryEffects {
  readonly #store: Pick<SqliteDiscussionStore, "recordControlMessage">;
  readonly #coordinator: Pick<DiscussionCoordinator, "refreshControl">;

  constructor(options: {
    readonly store: Pick<SqliteDiscussionStore, "recordControlMessage">;
    readonly coordinator: Pick<DiscussionCoordinator, "refreshControl">;
  }) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
  }

  async apply(message: OutboxMessage, result: OutboxSendResult): Promise<void> {
    const effect = message.deliveryEffect;
    if (effect?.kind !== "discussion.control.created") {
      throw new Error("Unsupported Outbox delivery effect");
    }
    if (result.messageId === undefined || !result.messageId.trim()) {
      throw new Error("Created Discussion control card did not return a message ID");
    }
    this.#store.recordControlMessage(effect.discussionId, result.messageId);
    await this.#coordinator.refreshControl(effect.discussionId);
  }
}

interface DiscussionAgentOutput {
  readonly message: string;
  readonly continueDiscussion: boolean;
  readonly openQuestions: readonly string[];
}

export class DiscussionCoordinator {
  readonly #store: SqliteDiscussionStore;
  readonly #events: EventStore;
  readonly #outbox: OutboxPort;
  readonly #adapters: AdapterRegistry;
  readonly #workspaceRoot: string;
  readonly #idFactory: () => string;
  readonly #semaphore: AgentCallLimiter;
  readonly #loops = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  #shuttingDown = false;

  constructor(options: DiscussionCoordinatorOptions) {
    this.#store = options.store;
    this.#events = options.events;
    this.#outbox = options.outbox;
    this.#adapters = options.adapters;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#idFactory = options.idFactory;
    this.#semaphore = options.limiter ?? new AgentConcurrencyLimiter(options.maxConcurrency ?? 3);
  }

  run(discussionId: string): Promise<void> {
    const existing = this.#loops.get(discussionId);
    if (existing !== undefined) return existing;
    if (this.#shuttingDown) throw new Error("Discussion coordinator is shutting down");
    const loop = this.#drive(discussionId);
    const tracked = loop.finally(() => {
      if (this.#loops.get(discussionId) === tracked) this.#loops.delete(discussionId);
      this.#controllers.delete(discussionId);
    });
    this.#loops.set(discussionId, tracked);
    return tracked;
  }

  kick(discussionId: string): void {
    void this.run(discussionId).catch(() => {});
  }

  async waitForIdle(discussionId: string): Promise<void> {
    await this.#loops.get(discussionId);
  }

  async control(
    discussionId: string,
    action: DiscussionAction,
    principalId: string,
  ): Promise<void> {
    const discussion = this.#requireDiscussion(discussionId);
    if (action === "stop") {
      const owner = this.#events.topic(discussion.topicId)?.ownerPrincipalId;
      if (principalId !== discussion.starterPrincipalId && principalId !== owner) {
        throw new Error("Only the Discussion starter or Topic owner may stop it");
      }
    }
    if (
      (action === "pause" && discussion.state === "paused")
      || (action === "resume" && discussion.state === "active")
      || (action === "summarize" && ["summarizing", "completed"].includes(discussion.state))
      || (action === "stop" && discussion.state === "stopped")
    ) {
      await this.refreshControl(discussionId);
      return;
    }
    const updated = transitionDiscussion(discussion, action);
    this.#store.saveDiscussion(updated);
    if (action === "pause" || action === "stop") {
      this.#controllers.get(discussionId)?.abort(new Error(`Discussion ${action} requested`));
    }
    await this.refreshControl(discussionId);
    if (action === "resume" || action === "summarize") this.kick(discussionId);
  }

  async refreshControl(discussionId: string): Promise<void> {
    const discussion = this.#requireDiscussion(discussionId);
    const turns = this.#store.turns(discussionId);
    const latestOpenQuestion = [...turns].reverse()
      .find((turn) => turn.openQuestions.length > 0)?.openQuestions[0];
    const topic = this.#events.topic(discussion.topicId);
    if (topic === undefined) throw new Error(`Topic not found: ${discussion.topicId}`);
    const card = discussionCard({
      discussionId,
      topicTitle: topic.title,
      question: discussion.question,
      state: discussion.state,
      round: discussion.round,
      maxRounds: discussion.maxRounds,
      pendingSteers: this.#store.pendingSteers(discussionId).length,
      version: discussion.version,
      ...(discussion.state === "active"
        ? { currentProvider: nextDiscussionProvider(discussion) }
        : {}),
      ...(latestOpenQuestion === undefined ? {} : { openQuestion: latestOpenQuestion }),
    });
    if (discussion.controlMessageId === undefined) {
      this.#outbox.enqueue({
        id: `outbox:discussion:${discussion.id}:control:create`,
        appRole: "hub",
        receiveId: discussion.chatId,
        payload: card,
        idempotencyKey: `discussion:${discussion.id}:control:create`,
        deliveryEffect: { kind: "discussion.control.created", discussionId },
      });
      return;
    }
    this.#outbox.enqueue({
      id: `outbox:discussion:${discussion.id}:control:update:${discussion.version}`,
      appRole: "hub",
      receiveId: discussion.chatId,
      payload: card,
      idempotencyKey: `discussion:${discussion.id}:control:update:${discussion.version}`,
      operation: "update",
      targetMessageId: discussion.controlMessageId,
    });
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const controller of this.#controllers.values()) {
      controller.abort(new Error("Discussion coordinator is shutting down"));
    }
    await Promise.allSettled(this.#loops.values());
  }

  async #drive(discussionId: string): Promise<void> {
    while (!this.#shuttingDown) {
      const discussion = this.#requireDiscussion(discussionId);
      this.#repairCompletedTurnEffects(discussion);
      await this.refreshControl(discussionId);
      if (discussion.state === "active") {
        if (await this.#reconcileCompletedTurn(discussion)) continue;
        await this.#executeTurn(discussion);
        continue;
      }
      if (discussion.state === "summarizing") {
        await this.#summarize(discussion);
      }
      return;
    }
  }

  async #executeTurn(discussion: GroupDiscussion): Promise<void> {
    const provider = nextDiscussionProvider(discussion);
    const priorTurn = this.#store.turnForIndex(discussion.id, discussion.turnIndex);
    const turnId = priorTurn?.id ?? this.#idFactory();
    if (priorTurn === undefined) {
      const claimed = this.#store.claimTurn({
        id: turnId,
        discussionId: discussion.id,
        provider,
        round: discussion.round,
        turnIndex: discussion.turnIndex,
      });
      if (!claimed) throw new Error("Discussion turn index was already claimed");
    } else {
      this.#store.restartTurn(turnId, provider, discussion.round);
    }
    const controller = new AbortController();
    this.#controllers.set(discussion.id, controller);
    const runningDiscussion: GroupDiscussion = {
      ...discussion,
      activeTurnId: turnId,
      version: discussion.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#store.saveDiscussion(runningDiscussion);
    await this.refreshControl(discussion.id);
    const steers = this.#store.pendingSteers(discussion.id);
    const prompt = discussionTurnPrompt({
      provider,
      question: discussion.question,
      round: discussion.round,
      transcript: this.#publicTranscript(discussion.id),
      pendingSteers: steers.map((steer) => ({
        principalId: steer.principalId,
        text: steer.text,
      })),
      sharedContext: this.#sharedContext(discussion.topicId),
    });
    try {
      const raw = await this.#callProvider(runningDiscussion, provider, prompt, controller.signal);
      const output = parseDiscussionAgentOutput(raw);
      const session = this.#events.agentSession(
        discussion.topicId,
        provider,
        `discussion:${discussion.id}`,
      );
      if (session?.externalSessionId === undefined) {
        throw new Error("Discussion provider Session was not persisted");
      }
      this.#store.completeTurn({
        id: turnId,
        externalSessionId: session.externalSessionId,
        text: output.message,
        continueDiscussion: output.continueDiscussion,
        openQuestions: output.openQuestions,
      });
      this.#store.consumeSteers(discussion.id, steers.map((steer) => steer.id));
      const updated = completeDiscussionTurn(runningDiscussion, {
        provider,
        continueDiscussion: output.continueDiscussion,
      });
      this.#store.saveDiscussion(updated);
      const completedTurn = this.#store.turn(turnId);
      if (completedTurn === undefined) throw new Error(`Completed Discussion turn not found: ${turnId}`);
      this.#publishCompletedTurn(discussion, completedTurn);
      await this.#afterTurn(updated);
    } catch (error) {
      const state = controller.signal.aborted ? "cancelled" : "failed";
      this.#store.failTurn(turnId, state);
      if (!controller.signal.aborted) {
        this.#outbox.enqueue({
          id: `outbox:discussion:${discussion.id}:visible:${discussion.turnIndex}:failed`,
          appRole: provider,
          receiveId: discussion.chatId,
          payload: textCard(`${providerLabel(provider)} 暂时无法发言`, errorMessage(error)),
          idempotencyKey: `discussion:${discussion.id}:visible:${discussion.turnIndex}:failed`,
        });
        const advanced = completeDiscussionTurn(runningDiscussion, {
          provider,
          continueDiscussion: true,
        });
        this.#store.saveDiscussion(advanced);
        await this.#afterTurn(advanced);
        return;
      }
      throw error;
    } finally {
      if (this.#controllers.get(discussion.id) === controller) {
        this.#controllers.delete(discussion.id);
      }
    }
  }

  async #afterTurn(discussion: GroupDiscussion): Promise<void> {
    if (discussion.turnIndex % 3 !== 0) {
      await this.refreshControl(discussion.id);
      return;
    }
    const completedRound = Math.ceil(discussion.turnIndex / 3);
    const roundTurns = this.#store.turns(discussion.id)
      .filter((turn) => turn.round === completedRound);
    const successes = roundTurns.filter((turn) => turn.state === "completed").length;
    if (successes < 2) {
      this.#store.saveDiscussion(transitionDiscussion(discussion, "pause"));
      await this.refreshControl(discussion.id);
      return;
    }
    const atLimit = discussion.turnIndex >= discussion.maxRounds * 3;
    if (
      atLimit
      || shouldSummarize(
        this.#store.roundVotes(discussion.id, completedRound),
        completedRound,
        discussion.maxRounds,
      )
    ) {
      this.#store.saveDiscussion(transitionDiscussion(discussion, "summarize"));
    }
    await this.refreshControl(discussion.id);
  }

  async #reconcileCompletedTurn(discussion: GroupDiscussion): Promise<boolean> {
    const turn = this.#store.turnForIndex(discussion.id, discussion.turnIndex);
    if (turn?.state !== "completed") return false;
    if (turn.continueDiscussion === undefined || turn.text === undefined) {
      throw new Error(`Completed Discussion turn is incomplete: ${turn.id}`);
    }
    const completedAt = turn.completedAt;
    const consumedSteers = this.#store.pendingSteers(discussion.id).filter(
      (steer) => completedAt !== undefined && steer.createdAt <= completedAt,
    );
    this.#store.consumeSteers(discussion.id, consumedSteers.map(({ id }) => id));
    const updated = completeDiscussionTurn(discussion, {
      provider: turn.provider,
      continueDiscussion: turn.continueDiscussion,
    });
    this.#store.saveDiscussion(updated);
    this.#publishCompletedTurn(discussion, turn);
    await this.#afterTurn(updated);
    return true;
  }

  #repairCompletedTurnEffects(discussion: GroupDiscussion): void {
    for (const turn of this.#store.turns(discussion.id)) {
      if (turn.state === "completed" && turn.text !== undefined && turn.continueDiscussion !== undefined) {
        this.#publishCompletedTurn(discussion, turn);
      }
    }
  }

  #publishCompletedTurn(discussion: GroupDiscussion, turn: DiscussionTurn): void {
    if (turn.text === undefined || turn.continueDiscussion === undefined) return;
    this.#events.append({
      topicId: discussion.topicId,
      type: "discussion.agent.completed",
      payload: {
        discussionId: discussion.id,
        turnId: turn.id,
        provider: turn.provider,
        round: turn.round,
        text: turn.text,
        continueDiscussion: turn.continueDiscussion,
        openQuestions: turn.openQuestions,
      },
      idempotencyKey: `discussion:${discussion.id}:turn:${turn.turnIndex}:completed`,
    });
    this.#outbox.enqueue({
      id: `outbox:discussion:${discussion.id}:visible:${turn.turnIndex}`,
      appRole: turn.provider,
      receiveId: discussion.chatId,
      payload: textCard(`${providerLabel(turn.provider)} · 第 ${turn.round} 轮`, turn.text),
      idempotencyKey: `discussion:${discussion.id}:visible:${turn.turnIndex}`,
    });
  }

  async #summarize(discussion: GroupDiscussion): Promise<void> {
    const provider = nextDiscussionProvider(discussion);
    const turns = this.#store.turns(discussion.id).filter(
      (turn): turn is DiscussionTurn & { text: string } =>
        turn.state === "completed" && turn.text !== undefined,
    );
    const prompt = discussionSummaryPrompt({
      question: discussion.question,
      transcript: turns.map((turn) => ({
        provider: turn.provider,
        text: turn.text,
        openQuestions: turn.openQuestions,
      })),
      reachedRoundLimit: discussion.turnIndex >= discussion.maxRounds * 3,
    });
    const controller = new AbortController();
    this.#controllers.set(discussion.id, controller);
    try {
      const raw = await this.#callProvider(discussion, provider, prompt, controller.signal);
      const summary = parseDiscussionSummary(raw);
      this.#events.append({
        topicId: discussion.topicId,
        type: "discussion.completed",
        payload: { discussionId: discussion.id, summary },
        idempotencyKey: `discussion:${discussion.id}:summary:completed`,
      });
      const completed: GroupDiscussion = {
        ...discussion,
        state: "completed",
        version: discussion.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.#store.saveDiscussion(completed);
      this.#outbox.enqueue({
        id: `outbox:discussion:${discussion.id}:summary:completed`,
        appRole: "hub",
        receiveId: discussion.chatId,
        payload: textCard("讨论总结", summary),
        idempotencyKey: `discussion:${discussion.id}:summary:completed`,
      });
      await this.refreshControl(discussion.id);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#store.saveDiscussion({
          ...discussion,
          state: "failed",
          version: discussion.version + 1,
          updatedAt: new Date().toISOString(),
        });
        await this.refreshControl(discussion.id);
      }
      throw error;
    } finally {
      if (this.#controllers.get(discussion.id) === controller) {
        this.#controllers.delete(discussion.id);
      }
    }
  }

  async #callProvider(
    discussion: GroupDiscussion,
    provider: ProviderName,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const role = `discussion:${discussion.id}`;
    const previous = this.#events.agentSession(discussion.topicId, provider, role);
    const task: AgentTask = {
      topicId: discussion.topicId,
      runId: `discussion-${discussion.id}-${this.#idFactory()}`,
      prompt,
      cwd: this.#workspace(discussion.topicId),
      signal,
    };
    const result = await this.#semaphore.run(async () =>
      previous?.externalSessionId === undefined
        ? this.#adapters[provider].start(task)
        : this.#adapters[provider].resume({
            ...task,
            externalSessionId: previous.externalSessionId,
          }),
    );
    const text = finalText(result.events);
    this.#events.upsertAgentSession({
      id: previous?.id ?? `discussion:${discussion.id}:${provider}`,
      topicId: discussion.topicId,
      provider,
      role,
      externalSessionId: result.externalSessionId,
      contextWatermark: this.#events.topic(discussion.topicId)?.lastEventSeq ?? 0,
      status: "active",
    });
    return text;
  }

  #publicTranscript(discussionId: string): Array<{ provider: ProviderName; text: string }> {
    return this.#store.turns(discussionId).flatMap((turn) =>
      turn.state === "completed" && turn.text !== undefined
        ? [{ provider: turn.provider, text: turn.text }]
        : [],
    );
  }

  #sharedContext(topicId: string): string[] {
    return this.#events.events(topicId).flatMap((event) => {
      if (event.type === "message.added") {
        const payload = asRecord(event.payload);
        return payload.note === true && typeof payload.text === "string" ? [payload.text] : [];
      }
      if (event.type === "research.completed") return [JSON.stringify(event.payload)];
      return [];
    });
  }

  #workspace(topicId: string): string {
    const workspace = resolve(this.#workspaceRoot, topicId, "discussion");
    if (
      workspace !== this.#workspaceRoot
      && !workspace.startsWith(`${this.#workspaceRoot}\\`)
      && !workspace.startsWith(`${this.#workspaceRoot}/`)
    ) {
      throw new Error("Discussion workspace escapes its configured root");
    }
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  #requireDiscussion(id: string): GroupDiscussion {
    const discussion = this.#store.discussion(id);
    if (discussion === undefined) throw new Error(`Discussion not found: ${id}`);
    return discussion;
  }
}

export interface GroupDiscussionReceiveInput {
  readonly tenantKey: string;
  readonly principalId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly sourceAppRole: "hub" | "claude" | "codex" | "copilot";
  readonly idempotencyKey: string;
  readonly preferredProvider?: ProviderName;
}

export class GroupDiscussionChannel {
  readonly #store: SqliteDiscussionStore;
  readonly #events: EventStore;
  readonly #coordinator: Pick<DiscussionCoordinator, "refreshControl" | "kick">;
  readonly #idFactory: () => string;

  constructor(options: {
    readonly store: SqliteDiscussionStore;
    readonly events: EventStore;
    readonly coordinator: Pick<DiscussionCoordinator, "refreshControl" | "kick">;
    readonly idFactory: () => string;
  }) {
    this.#store = options.store;
    this.#events = options.events;
    this.#coordinator = options.coordinator;
    this.#idFactory = options.idFactory;
  }

  async receive(input: GroupDiscussionReceiveInput): Promise<void> {
    const priorReceipt = this.#store.steerForMessage(input.messageId);
    if (priorReceipt !== undefined) {
      this.#store.recordSteer({
        id: priorReceipt.id,
        discussionId: priorReceipt.discussionId,
        messageId: input.messageId,
        topicEventSeq: priorReceipt.topicEventSeq,
        principalId: input.principalId,
        text: input.text,
        ...(input.preferredProvider === undefined
          ? {}
          : { preferredProvider: input.preferredProvider }),
      });
      await this.#coordinator.refreshControl(priorReceipt.discussionId);
      this.#coordinator.kick(priorReceipt.discussionId);
      return;
    }

    const active = this.#store.activeForChat(input.tenantKey, input.chatId);
    if (active !== undefined) {
      const event = this.#events.append({
        topicId: active.topicId,
        type: "discussion.steer.added",
        actorPrincipalId: input.principalId,
        payload: {
          discussionId: active.id,
          messageId: input.messageId,
          text: input.text,
          ...(input.preferredProvider === undefined
            ? {}
            : { preferredProvider: input.preferredProvider }),
        },
        idempotencyKey: `group-message:${input.messageId}:steer`,
      });
      this.#store.recordSteer({
        id: this.#idFactory(),
        discussionId: active.id,
        messageId: input.messageId,
        topicEventSeq: event.seq,
        principalId: input.principalId,
        text: input.text,
        ...(input.preferredProvider === undefined
          ? {}
          : { preferredProvider: input.preferredProvider }),
      });
      await this.#coordinator.refreshControl(active.id);
      this.#coordinator.kick(active.id);
      return;
    }

    let topicId = this.#store.chatTopic(input.tenantKey, input.chatId);
    const boundTopic = topicId === undefined ? undefined : this.#events.topic(topicId);
    if (boundTopic === undefined || boundTopic.status !== "active") {
      const topic = createTopic(summarizeQuestion(input.text), input.principalId, {
        id: this.#idFactory(),
      });
      this.#events.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: input.principalId,
        payload: { topic },
        createdAt: topic.createdAt,
        idempotencyKey: `group-message:${input.messageId}:topic`,
      });
      topicId = topic.id;
      this.#store.bindChatTopic(input.tenantKey, input.chatId, topic.id);
    }
    if (topicId === undefined) throw new Error("Group Topic binding was not created");
    const discussion = createDiscussion({
      id: this.#idFactory(),
      topicId,
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      question: input.text,
      starterPrincipalId: input.principalId,
    });
    this.#store.createDiscussion(discussion);
    const started = this.#events.append({
      topicId,
      type: "discussion.started",
      actorPrincipalId: input.principalId,
      payload: {
        discussionId: discussion.id,
        chatId: input.chatId,
        messageId: input.messageId,
        question: input.text,
      },
      idempotencyKey: `group-message:${input.messageId}:discussion-started`,
    });
    const initialReceipt = this.#store.recordSteer({
      id: this.#idFactory(),
      discussionId: discussion.id,
      messageId: input.messageId,
      topicEventSeq: started.seq,
      principalId: input.principalId,
      text: input.text,
      ...(input.preferredProvider === undefined
        ? {}
        : { preferredProvider: input.preferredProvider }),
    }).steer;
    this.#store.consumeSteers(discussion.id, [initialReceipt.id]);
    await this.#coordinator.refreshControl(discussion.id);
    this.#coordinator.kick(discussion.id);
  }
}

export function parseDiscussionAgentOutput(raw: string): DiscussionAgentOutput {
  try {
    const value = asRecord(JSON.parse(raw) as unknown);
    if (
      typeof value.message !== "string"
      || !value.message.trim()
      || typeof value.continueDiscussion !== "boolean"
      || !Array.isArray(value.openQuestions)
      || value.openQuestions.some((question) => typeof question !== "string")
    ) {
      throw new Error("invalid contract");
    }
    return {
      message: value.message.trim(),
      continueDiscussion: value.continueDiscussion,
      openQuestions: value.openQuestions as string[],
    };
  } catch {
    const message = raw.trim();
    if (!message) throw new Error("Discussion Agent returned an empty response");
    return { message, continueDiscussion: true, openQuestions: [] };
  }
}

function parseDiscussionSummary(raw: string): string {
  try {
    const value = asRecord(JSON.parse(raw) as unknown);
    if (typeof value.summary === "string" && value.summary.trim()) return value.summary.trim();
  } catch {
    // Fall back to the provider's visible text.
  }
  const summary = raw.trim();
  if (!summary) throw new Error("Discussion summary is empty");
  return summary;
}

function finalText(events: readonly { readonly type: string; readonly [key: string]: unknown }[]): string {
  const fatal = events.find((event) => event.type === "error" && event.code !== "process_stderr");
  if (fatal !== undefined) throw new Error(`Discussion provider failed: ${String(fatal.code)}`);
  const final = [...events].reverse().find(
    (event) => event.type === "final" && typeof event.text === "string",
  );
  if (final === undefined || typeof final.text !== "string") {
    throw new Error("Discussion provider did not emit a final event");
  }
  return final.text;
}

function providerLabel(provider: ProviderName): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Copilot";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown provider failure";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("value is not an object");
  }
  return value as Record<string, unknown>;
}

function summarizeQuestion(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}
