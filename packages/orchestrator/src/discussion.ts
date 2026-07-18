import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertValidProviderText,
  type AdapterRegistry,
  type AgentTask,
  type ProviderName,
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
  type DiscussionSteer,
  type DiscussionTurn,
  SqliteDiscussionStore,
} from "../../storage/src/discussion.js";
import type { EventStore, TopicEvent } from "../../storage/src/store.js";
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
  readonly onError?: (discussionId: string, error: unknown) => void;
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

const MAX_STALE_SUMMARY_REGENERATIONS = 3;

class DiscussionInterruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscussionInterruption";
  }
}

export class DiscussionCoordinator {
  readonly #store: SqliteDiscussionStore;
  readonly #events: EventStore;
  readonly #outbox: OutboxPort;
  readonly #adapters: AdapterRegistry;
  readonly #workspaceRoot: string;
  readonly #idFactory: () => string;
  readonly #semaphore: AgentCallLimiter;
  readonly #onError: (discussionId: string, error: unknown) => void;
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
    this.#onError = options.onError ?? ((discussionId, error) => {
      console.error(`Discussion ${discussionId} failed: ${errorMessage(error)}`);
    });
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
    const recovery = this.run(discussionId).catch(async (error: unknown) => {
      if (error instanceof DiscussionInterruption) return;
      this.#onError(discussionId, error);
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const current = this.#requireDiscussion(discussionId);
          if (current.state !== "active" && current.state !== "summarizing") break;
          const paused = transitionDiscussion(current, "pause");
          if (this.#store.saveDiscussionCas(paused, current.version)) break;
        }
        await this.refreshControl(discussionId);
      } catch (recoveryError) {
        this.#onError(discussionId, recoveryError);
      }
    });
    const tracked = recovery.finally(() => {
      if (this.#loops.get(discussionId) === tracked) this.#loops.delete(discussionId);
    });
    this.#loops.set(discussionId, tracked);
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
    const activeLoop = this.#loops.get(discussionId);
    let updated: GroupDiscussion | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.#requireDiscussion(discussionId);
      if (
        (action === "pause" && current.state === "paused")
        || (action === "resume" && current.state === "active")
        || (action === "summarize" && ["summarizing", "completed"].includes(current.state))
        || (action === "stop" && current.state === "stopped")
      ) {
        await this.refreshControl(discussionId);
        return;
      }
      const candidate = transitionDiscussion(current, action);
      if (this.#store.saveDiscussionCas(candidate, current.version)) {
        updated = candidate;
        break;
      }
    }
    if (updated === undefined) throw new Error(`Discussion control conflicted repeatedly: ${discussionId}`);
    this.#events.append({
      topicId: updated.topicId,
      type: "discussion.controlled",
      actorPrincipalId: principalId,
      payload: { discussionId, action, version: updated.version },
      idempotencyKey: `discussion:${discussionId}:control:${updated.version}:${action}`,
    });
    if (action === "pause" || action === "stop" || action === "summarize") {
      this.#controllers.get(discussionId)?.abort(
        new DiscussionInterruption(`Discussion ${action} requested`),
      );
    }
    if (action === "resume" || action === "summarize") await activeLoop?.catch(() => {});
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
      controller.abort(new DiscussionInterruption("Discussion coordinator is shutting down"));
    }
    await Promise.allSettled(this.#loops.values());
  }

  async #drive(discussionId: string): Promise<void> {
    while (!this.#shuttingDown) {
      const discussion = this.#requireDiscussion(discussionId);
      this.#repairCompletedTurnEffects(discussion);
      this.#repairSummaryEffect(discussion);
      await this.refreshControl(discussionId);
      if (discussion.state === "active") {
        if (discussion.turnIndex > 0 && discussion.turnIndex % 3 === 0) {
          await this.#afterTurn(discussion);
          if (this.#requireDiscussion(discussionId).state !== "active") continue;
        }
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
    const steers = this.#store.pendingSteers(discussion.id);
    const priorTurn = this.#store.turnForIndex(discussion.id, discussion.turnIndex);
    const turnId = priorTurn?.id ?? this.#idFactory();
    if (priorTurn === undefined) {
      const claimed = this.#store.claimTurn({
        id: turnId,
        discussionId: discussion.id,
        provider,
        round: discussion.round,
        turnIndex: discussion.turnIndex,
        steerIds: steers.map(({ id }) => id),
      });
      if (!claimed) throw new Error("Discussion turn index was already claimed");
    } else {
      this.#store.restartTurn(turnId, provider, discussion.round, steers.map(({ id }) => id));
    }
    const controller = new AbortController();
    this.#controllers.set(discussion.id, controller);
    const runningDiscussion = this.#store.activateTurn(
      discussion.id,
      turnId,
      discussion.turnIndex,
      provider,
    );
    await this.refreshControl(discussion.id);
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
    let output: DiscussionAgentOutput;
    try {
      const raw = await this.#callProvider(runningDiscussion, provider, prompt, controller.signal);
      output = parseDiscussionAgentOutput(raw);
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
        const advanced = this.#advanceTurn(discussion.id, turnId, provider, true);
        if (advanced !== undefined) await this.#afterTurn(advanced);
        if (this.#controllers.get(discussion.id) === controller) {
          this.#controllers.delete(discussion.id);
        }
        return;
      }
      this.#store.clearActiveTurn(discussion.id, turnId);
      if (this.#controllers.get(discussion.id) === controller) {
        this.#controllers.delete(discussion.id);
      }
      throw interruptionReason(controller.signal, error);
    }
    try {
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
      const completedTurn = this.#store.turn(turnId);
      if (completedTurn === undefined) throw new Error(`Completed Discussion turn not found: ${turnId}`);
      this.#store.consumeSteers(discussion.id, completedTurn.steerIds);
      this.#publishCompletedTurn(discussion, completedTurn);
      const updated = this.#advanceTurn(
        discussion.id,
        turnId,
        provider,
        output.continueDiscussion,
      );
      if (updated !== undefined) await this.#afterTurn(updated);
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
    let reconciled = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.#requireDiscussion(discussion.id);
      if (current.state !== "active" || current.turnIndex !== discussion.turnIndex) {
        reconciled = true;
        break;
      }
      const completedRound = Math.ceil(current.turnIndex / 3);
      const roundTurns = this.#store.turns(current.id)
        .filter((turn) => turn.round === completedRound);
      const successes = roundTurns.filter((turn) => turn.state === "completed").length;
      const atLimit = current.turnIndex >= current.maxRounds * 3;
      const summarize = atLimit || shouldSummarize(
        this.#store.roundVotes(current.id, completedRound),
        completedRound,
        current.maxRounds,
      );
      if (current.evaluatedTurnIndex >= current.turnIndex && !summarize) {
        reconciled = true;
        break;
      }
      const transitioned = successes < 2 && current.evaluatedTurnIndex < current.turnIndex
        ? transitionDiscussion(current, "pause")
        : summarize
          ? transitionDiscussion(current, "summarize")
          : {
              ...current,
              version: current.version + 1,
              updatedAt: new Date().toISOString(),
            };
      const evaluated = {
        ...transitioned,
        evaluatedTurnIndex: Math.max(current.evaluatedTurnIndex, current.turnIndex),
      };
      if (this.#store.saveDiscussionCas(evaluated, current.version)) {
        reconciled = true;
        break;
      }
    }
    if (!reconciled) {
      throw new Error(`Discussion boundary evaluation conflicted repeatedly: ${discussion.id}`);
    }
    await this.refreshControl(discussion.id);
  }

  async #reconcileCompletedTurn(discussion: GroupDiscussion): Promise<boolean> {
    const turn = this.#store.turnForIndex(discussion.id, discussion.turnIndex);
    if (turn?.state !== "completed") return false;
    if (turn.continueDiscussion === undefined || turn.text === undefined) {
      throw new Error(`Completed Discussion turn is incomplete: ${turn.id}`);
    }
    this.#store.consumeSteers(discussion.id, turn.steerIds);
    const updated = this.#advanceTurn(
      discussion.id,
      turn.id,
      turn.provider,
      turn.continueDiscussion,
    );
    if (updated === undefined) return false;
    this.#publishCompletedTurn(discussion, turn);
    await this.#afterTurn(updated);
    return true;
  }

  #advanceTurn(
    discussionId: string,
    turnId: string,
    provider: ProviderName,
    continueDiscussion: boolean,
  ): GroupDiscussion | undefined {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.#requireDiscussion(discussionId);
      if (current.state !== "active" || current.activeTurnId !== turnId) return undefined;
      const pendingPreferred = current.preferredProvider;
      const updatedBase = completeDiscussionTurn(
        { ...current, preferredProvider: provider },
        { provider, continueDiscussion },
      );
      const updated = pendingPreferred === undefined
        ? updatedBase
        : { ...updatedBase, preferredProvider: pendingPreferred };
      if (this.#store.saveDiscussionCas(updated, current.version)) return updated;
    }
    throw new Error(`Discussion turn advancement conflicted repeatedly: ${discussionId}`);
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

  #repairSummaryEffect(discussion: GroupDiscussion): void {
    if (discussion.state !== "completed" || discussion.summaryText === undefined) return;
    this.#events.append({
      topicId: discussion.topicId,
      type: "discussion.completed",
      payload: { discussionId: discussion.id, summary: discussion.summaryText },
      idempotencyKey: `discussion:${discussion.id}:summary:completed`,
    });
    this.#outbox.enqueue({
      id: `outbox:discussion:${discussion.id}:summary:completed`,
      appRole: "hub",
      receiveId: discussion.chatId,
      payload: textCard("讨论总结", discussion.summaryText),
      idempotencyKey: `discussion:${discussion.id}:summary:completed`,
    });
  }

  async #summarize(discussion: GroupDiscussion): Promise<void> {
    const firstProvider = nextDiscussionProvider(discussion);
    const providers: ProviderName[] = [
      firstProvider,
      ...(["claude", "codex", "copilot"] as const).filter(
        (provider) => provider !== firstProvider,
      ),
    ];
    const turns = this.#store.turns(discussion.id).filter(
      (turn): turn is DiscussionTurn & { text: string } =>
        turn.state === "completed" && turn.text !== undefined,
    );
    const controller = new AbortController();
    this.#controllers.set(discussion.id, controller);
    let staleRegenerations = 0;
    try {
      while (true) {
        const steers = this.#store.pendingSteers(discussion.id);
        const prompt = discussionSummaryPrompt({
          question: discussion.question,
          pendingSteers: steers.map((steer) => ({
            principalId: steer.principalId,
            text: steer.text,
          })),
          transcript: turns.map((turn) => ({
            provider: turn.provider,
            text: turn.text,
            openQuestions: turn.openQuestions,
          })),
          reachedRoundLimit: discussion.turnIndex >= discussion.maxRounds * 3,
        });
        let summary: string | undefined;
        const failures: string[] = [];
        for (const provider of providers) {
          try {
            const raw = await this.#callProvider(discussion, provider, prompt, controller.signal);
            summary = parseDiscussionSummary(raw);
            break;
          } catch (error) {
            if (controller.signal.aborted) throw interruptionReason(controller.signal, error);
            failures.push(`${providerLabel(provider)}: ${errorMessage(error)}`);
          }
        }
        if (summary === undefined) {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = this.#requireDiscussion(discussion.id);
            if (current.state !== "summarizing") break;
            const paused = transitionDiscussion(current, "pause");
            if (this.#store.saveDiscussionCas(paused, current.version)) break;
          }
          const current = this.#requireDiscussion(discussion.id);
          this.#outbox.enqueue({
            id: `outbox:discussion:${discussion.id}:summary:failed:${current.version}`,
            appRole: "hub",
            receiveId: discussion.chatId,
            payload: textCard("总结暂不可用", `${failures.join("\n")}\n\n可稍后点击「立即总结」重试。`),
            idempotencyKey: `discussion:${discussion.id}:summary:failed:${current.version}`,
          });
          await this.refreshControl(discussion.id);
          return;
        }
        const finalized = this.#store.finalizeSummary(
          discussion.id,
          summary,
          steers.map(({ id }) => id),
        );
        if (finalized.status === "inactive") return;
        if (finalized.status === "retry") {
          if (staleRegenerations < MAX_STALE_SUMMARY_REGENERATIONS) {
            staleRegenerations += 1;
            continue;
          }
          let paused: GroupDiscussion | undefined;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = this.#requireDiscussion(discussion.id);
            if (current.state !== "summarizing") return;
            const candidate = transitionDiscussion(current, "pause");
            if (this.#store.saveDiscussionCas(candidate, current.version)) {
              paused = candidate;
              break;
            }
          }
          if (paused === undefined) {
            throw new Error(`Discussion summary activity pause conflicted repeatedly: ${discussion.id}`);
          }
          this.#outbox.enqueue({
            id: `outbox:discussion:${discussion.id}:summary:steers-active:${paused.version}`,
            appRole: "hub",
            receiveId: discussion.chatId,
            payload: textCard(
              "总结已暂停",
              "讨论持续收到新指令，已暂停总结以避免发布过时结论。可稍后点击「立即总结」重试。",
            ),
            idempotencyKey: `discussion:${discussion.id}:summary:steers-active:${paused.version}`,
          });
          await this.refreshControl(discussion.id);
          return;
        }
        this.#repairSummaryEffect(finalized.discussion);
        await this.refreshControl(discussion.id);
        return;
      }
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

  recoverPendingSteerEvents(): void {
    for (const event of this.#events.eventsByType("discussion.steer.added")) {
      const linkedReceipts = this.#store.steersForTopicEvent(event.topicId, event.seq);
      if (linkedReceipts.length > 1) {
        throw new Error(
          `Multiple Discussion steer receipts link to TopicEvent ${event.topicId}:${event.seq}`,
        );
      }
      const input = recoveryInputForSteerEvent(event);
      const payload = recordValue(event.payload);
      const discussionId = payload?.discussionId;
      if (typeof discussionId !== "string") {
        throw new Error("Inconsistent discussion.steer.added event");
      }
      const discussion = this.#store.discussion(discussionId);
      if (discussion === undefined) {
        throw new Error("Inconsistent discussion.steer.added event");
      }
      assertDiscussionSteerAddedEvent(event, input, discussion, true);
      const linkedReceipt = linkedReceipts[0];
      if (linkedReceipt !== undefined) {
        assertSteerReceiptMatchesEvent(linkedReceipt, input, discussion);
        this.#store.recordSteer({
          id: linkedReceipt.id,
          discussionId: discussion.id,
          messageId: input.messageId,
          topicEventSeq: event.seq,
          principalId: input.principalId,
          text: input.text,
          ...(input.preferredProvider === undefined
            ? {}
            : { preferredProvider: input.preferredProvider }),
        });
        continue;
      }
      const existing = this.#store.steerForMessage(input.messageId);
      if (existing !== undefined) {
        assertSteerReceiptMatchesEvent(existing, input, discussion);
        this.#store.recordSteer({
          id: existing.id,
          discussionId: discussion.id,
          messageId: input.messageId,
          topicEventSeq: event.seq,
          principalId: input.principalId,
          text: input.text,
          ...(input.preferredProvider === undefined
            ? {}
            : { preferredProvider: input.preferredProvider }),
        });
        continue;
      }
      const recoveredInput = {
        id: this.#idFactory(),
        discussionId: discussion.id,
        messageId: input.messageId,
        topicEventSeq: event.seq,
        principalId: input.principalId,
        text: input.text,
        ...(input.preferredProvider === undefined
          ? {}
          : { preferredProvider: input.preferredProvider }),
        createdAt: event.createdAt,
      };
      if (["active", "paused", "summarizing"].includes(discussion.state)) {
        this.#store.recordSteer(recoveredInput);
      } else {
        this.#store.recordTerminalSteerTombstone(recoveredInput, event.createdAt);
      }
    }
    for (const steer of this.#store.unpublishedSteers()) {
      const discussion = this.#store.discussion(steer.discussionId);
      if (discussion === undefined) {
        throw new Error(`Discussion not found for unpublished steer: ${steer.id}`);
      }
      this.#publishSteerEvent({
        tenantKey: discussion.tenantKey,
        principalId: steer.principalId,
        chatId: discussion.chatId,
        messageId: steer.messageId,
        text: steer.text,
        sourceAppRole: "hub",
        idempotencyKey: `discussion-steer-recovery:${steer.id}`,
        ...(steer.preferredProvider === undefined
          ? {}
          : { preferredProvider: steer.preferredProvider }),
      }, discussion, steer.id, true);
    }
  }

  async receive(input: GroupDiscussionReceiveInput): Promise<void> {
    const active = this.#store.activeForChat(input.tenantKey, input.chatId);
    const priorStart = this.#store.discussionForStartMessage(input.messageId);
    if (priorStart !== undefined) {
      if (priorStart.tenantKey !== input.tenantKey || priorStart.chatId !== input.chatId) return;
      if (
        priorStart.starterPrincipalId !== input.principalId
        || priorStart.question !== input.text
      ) {
        throw new Error("Inconsistent Discussion start replay");
      }
      if (input.sourceAppRole !== "hub" && active?.id !== priorStart.id) return;
      await this.#finishStart(input, priorStart);
      return;
    }

    const priorReceipt = this.#store.steerForMessage(input.messageId);
    if (priorReceipt !== undefined) {
      const receiptDiscussion = this.#store.discussion(priorReceipt.discussionId);
      if (
        receiptDiscussion === undefined
        || receiptDiscussion.tenantKey !== input.tenantKey
        || receiptDiscussion.chatId !== input.chatId
      ) return;
      if (priorReceipt.principalId !== input.principalId || priorReceipt.text !== input.text) {
        throw new Error("Inconsistent Discussion steer replay");
      }
      if (
        input.sourceAppRole !== "hub"
        && active?.id !== priorReceipt.discussionId
        && priorReceipt.topicEventSeq !== 0
      ) return;
      const preferredProvider = reconcilePreferredProvider(
        priorReceipt.preferredProvider,
        input.preferredProvider,
      );
      this.#publishSteerEvent({
        ...input,
        ...(preferredProvider === undefined ? {} : { preferredProvider }),
      }, receiptDiscussion, priorReceipt.id, true);
      await this.#coordinator.refreshControl(priorReceipt.discussionId);
      this.#coordinator.kick(priorReceipt.discussionId);
      return;
    }

    if (active !== undefined) {
      const effectKey = groupEffectKey(
        input.tenantKey,
        input.chatId,
        input.messageId,
        "steer",
      );
      const priorEvent = this.#events.eventForEffect(effectKey);
      if (priorEvent !== undefined) {
        assertDiscussionSteerAddedEvent(priorEvent, input, active);
      }
      const preferredProvider = priorEvent === undefined
        ? input.preferredProvider
        : steerEventPreferredProvider(priorEvent) ?? input.preferredProvider;
      const receipt = this.#store.recordSteer({
        id: this.#idFactory(),
        discussionId: active.id,
        messageId: input.messageId,
        ...(priorEvent === undefined ? {} : { topicEventSeq: priorEvent.seq }),
        principalId: input.principalId,
        text: input.text,
        ...(preferredProvider === undefined
          ? {}
          : { preferredProvider }),
      }).steer;
      if (priorEvent === undefined) {
        this.#publishSteerEvent(input, active, receipt.id, false);
      }
      await this.#coordinator.refreshControl(active.id);
      this.#coordinator.kick(active.id);
      return;
    }

    if (input.sourceAppRole !== "hub") return;

    let topicId = this.#store.chatTopic(input.tenantKey, input.chatId);
    const boundTopic = topicId === undefined ? undefined : this.#events.topic(topicId);
    if (boundTopic !== undefined && boundTopic.tenantKey !== input.tenantKey) {
      throw new Error("Group Topic tenant does not match chat tenant");
    }
    if (boundTopic === undefined || boundTopic.status !== "active") {
      const topic = createTopic(summarizeQuestion(input.text), input.principalId, {
        id: this.#idFactory(),
      });
      const created = this.#events.append({
        topicId: topic.id,
        type: "topic.created",
        actorPrincipalId: input.principalId,
        payload: {
          schemaVersion: GROUP_EFFECT_SCHEMA_VERSION,
          topic,
          principalId: input.principalId,
          question: input.text,
          tenantKey: input.tenantKey,
          chatId: input.chatId,
          messageId: input.messageId,
        },
        createdAt: topic.createdAt,
        idempotencyKey: groupEffectKey(
          input.tenantKey,
          input.chatId,
          input.messageId,
          "topic",
        ),
      });
      assertTopicCreatedEvent(created, input);
      topicId = created.topicId;
      this.#store.bindChatTopic(input.tenantKey, input.chatId, created.topicId);
    }
    if (topicId === undefined) throw new Error("Group Topic binding was not created");
    const discussion = this.#store.createDiscussion(createDiscussion({
      id: this.#idFactory(),
      topicId,
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      question: input.text,
      starterPrincipalId: input.principalId,
      startMessageId: input.messageId,
    }));
    await this.#finishStart(input, discussion);
  }

  async #finishStart(input: GroupDiscussionReceiveInput, discussion: GroupDiscussion): Promise<void> {
    const priorReceipt = this.#store.steerForMessage(input.messageId);
    let topicEventSeq: number;
    if (priorReceipt?.discussionId === discussion.id) {
      if (
        priorReceipt.principalId !== discussion.starterPrincipalId
        || priorReceipt.text !== discussion.question
      ) {
        throw new Error("Inconsistent Discussion start receipt");
      }
      topicEventSeq = priorReceipt.topicEventSeq;
    } else {
      const started = this.#events.append({
        topicId: discussion.topicId,
        type: "discussion.started",
        actorPrincipalId: discussion.starterPrincipalId,
        payload: {
          schemaVersion: GROUP_EFFECT_SCHEMA_VERSION,
          discussionId: discussion.id,
          starterPrincipalId: discussion.starterPrincipalId,
          tenantKey: discussion.tenantKey,
          chatId: discussion.chatId,
          messageId: input.messageId,
          question: discussion.question,
        },
        idempotencyKey: groupEffectKey(
          input.tenantKey,
          input.chatId,
          input.messageId,
          "discussion-started",
        ),
      });
      assertDiscussionStartedEvent(started, input, discussion);
      topicEventSeq = started.seq;
    }
    const initialReceipt = this.#store.recordSteer({
      id: this.#idFactory(),
      discussionId: discussion.id,
      messageId: input.messageId,
      topicEventSeq,
      principalId: discussion.starterPrincipalId,
      text: discussion.question,
      ...(input.preferredProvider === undefined
        ? {}
        : { preferredProvider: input.preferredProvider }),
    }).steer;
    this.#store.consumeSteers(discussion.id, [initialReceipt.id]);
    await this.#coordinator.refreshControl(discussion.id);
    this.#coordinator.kick(discussion.id);
  }

  #publishSteerEvent(
    input: GroupDiscussionReceiveInput,
    discussion: GroupDiscussion,
    steerId: string,
    allowTerminal: boolean,
  ): void {
    const event = this.#events.append({
      topicId: discussion.topicId,
      type: "discussion.steer.added",
      actorPrincipalId: input.principalId,
      payload: {
        schemaVersion: GROUP_EFFECT_SCHEMA_VERSION,
        discussionId: discussion.id,
        principalId: input.principalId,
        tenantKey: input.tenantKey,
        chatId: input.chatId,
        messageId: input.messageId,
        text: input.text,
        ...(input.preferredProvider === undefined
          ? {}
          : { preferredProvider: input.preferredProvider }),
      },
      idempotencyKey: groupEffectKey(
        input.tenantKey,
        input.chatId,
        input.messageId,
        "steer",
      ),
    });
    assertDiscussionSteerAddedEvent(event, input, discussion, allowTerminal);
    this.#store.recordSteer({
      id: steerId,
      discussionId: discussion.id,
      messageId: input.messageId,
      topicEventSeq: event.seq,
      principalId: input.principalId,
      text: input.text,
      ...(input.preferredProvider === undefined
        ? {}
        : { preferredProvider: input.preferredProvider }),
    });
  }
}

export function parseDiscussionAgentOutput(raw: string): DiscussionAgentOutput {
  assertValidProviderText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(raw)) as unknown;
  } catch {
    const message = raw.trim();
    if (!message) throw new Error("Discussion Agent returned an empty response");
    return { message, continueDiscussion: true, openQuestions: [] };
  }
  assertValidDecodedProviderValue(parsed);
  let value: Record<string, unknown>;
  try {
    value = asRecord(parsed);
  } catch {
    return { message: raw.trim(), continueDiscussion: true, openQuestions: [] };
  }
  if (
    typeof value.message !== "string"
    || !value.message.trim()
    || typeof value.continueDiscussion !== "boolean"
    || !Array.isArray(value.openQuestions)
    || value.openQuestions.some((question) => typeof question !== "string")
  ) {
    return { message: raw.trim(), continueDiscussion: true, openQuestions: [] };
  }
  return {
    message: value.message.trim(),
    continueDiscussion: value.continueDiscussion,
    openQuestions: value.openQuestions as string[],
  };
}

function parseDiscussionSummary(raw: string): string {
  assertValidProviderText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(raw)) as unknown;
  } catch {
    const summary = raw.trim();
    if (!summary) throw new Error("Discussion summary is empty");
    return summary;
  }
  assertValidDecodedProviderValue(parsed);
  let summary: string | undefined;
  try {
    const value = asRecord(parsed);
    if (typeof value.summary === "string" && value.summary.trim()) summary = value.summary.trim();
  } catch {
    // Fall back to the provider's visible text.
  }
  summary ??= raw.trim();
  if (!summary) throw new Error("Discussion summary is empty");
  assertValidProviderText(summary);
  return summary;
}

function unwrapJsonFence(raw: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  return fenced?.[1] ?? raw;
}

function interruptionReason(signal: AbortSignal, fallback: unknown): unknown {
  return signal.reason instanceof DiscussionInterruption ? signal.reason : fallback;
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

function assertValidDecodedProviderValue(value: unknown): void {
  if (typeof value === "string") {
    assertValidProviderText(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertValidDecodedProviderValue(item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) assertValidDecodedProviderValue(item);
  }
}

function summarizeQuestion(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}

type GroupEffectOperation = "topic" | "discussion-started" | "steer";
const GROUP_EFFECT_SCHEMA_VERSION = 2;

function groupEffectKey(
  tenantKey: string,
  chatId: string,
  messageId: string,
  operation: GroupEffectOperation,
): string {
  return `group-message:${JSON.stringify([tenantKey, chatId, messageId, operation])}`;
}

function assertTopicCreatedEvent(
  event: TopicEvent,
  input: GroupDiscussionReceiveInput,
): void {
  const payload = recordValue(event.payload);
  const topic = recordValue(payload?.topic);
  const currentPayload = payload?.schemaVersion === GROUP_EFFECT_SCHEMA_VERSION;
  const legacyPayload = hasExactLegacyPayloadShape(
    payload,
    ["topic", "tenantKey", "chatId", "messageId"],
  );
  if (
    event.type !== "topic.created"
    || (!currentPayload && !legacyPayload)
    || topic?.id !== event.topicId
    || event.actorPrincipalId !== input.principalId
    || topic.ownerPrincipalId !== input.principalId
    || topic.tenantKey !== input.tenantKey
    || topic.title !== summarizeQuestion(input.text)
    || (currentPayload && payload?.principalId !== input.principalId)
    || (currentPayload && payload?.question !== input.text)
    || payload?.tenantKey !== input.tenantKey
    || payload.chatId !== input.chatId
    || payload.messageId !== input.messageId
  ) {
    throw new Error("Inconsistent topic.created event");
  }
}

function assertDiscussionStartedEvent(
  event: TopicEvent,
  input: GroupDiscussionReceiveInput,
  discussion: GroupDiscussion,
): void {
  const payload = recordValue(event.payload);
  const currentPayload = payload?.schemaVersion === GROUP_EFFECT_SCHEMA_VERSION;
  const legacyPayload = hasExactLegacyPayloadShape(
    payload,
    ["discussionId", "tenantKey", "chatId", "messageId", "question"],
  );
  if (
    event.type !== "discussion.started"
    || (!currentPayload && !legacyPayload)
    || event.topicId !== discussion.topicId
    || event.actorPrincipalId !== discussion.starterPrincipalId
    || discussion.tenantKey !== input.tenantKey
    || discussion.chatId !== input.chatId
    || discussion.startMessageId !== input.messageId
    || discussion.starterPrincipalId !== input.principalId
    || discussion.question !== input.text
    || payload?.discussionId !== discussion.id
    || (currentPayload && payload?.starterPrincipalId !== discussion.starterPrincipalId)
    || payload.tenantKey !== input.tenantKey
    || payload.chatId !== input.chatId
    || payload.messageId !== input.messageId
    || payload.question !== discussion.question
  ) {
    throw new Error("Inconsistent discussion.started event");
  }
}

function assertDiscussionSteerAddedEvent(
  event: TopicEvent,
  input: GroupDiscussionReceiveInput,
  discussion: GroupDiscussion,
  allowTerminal = false,
): void {
  const payload = recordValue(event.payload);
  const currentPayload = payload?.schemaVersion === GROUP_EFFECT_SCHEMA_VERSION;
  const legacyPayload = hasExactLegacyPayloadShape(
    payload,
    ["discussionId", "tenantKey", "chatId", "messageId", "text"],
    ["preferredProvider"],
  );
  const eventPreferredProvider = steerEventPreferredProvider(event);
  if (
    event.type !== "discussion.steer.added"
    || (!currentPayload && !legacyPayload)
    || event.topicId !== discussion.topicId
    || event.actorPrincipalId !== input.principalId
    || (!allowTerminal && !["active", "paused", "summarizing"].includes(discussion.state))
    || discussion.tenantKey !== input.tenantKey
    || discussion.chatId !== input.chatId
    || payload?.discussionId !== discussion.id
    || (currentPayload && payload?.principalId !== input.principalId)
    || payload.tenantKey !== input.tenantKey
    || payload.chatId !== input.chatId
    || payload.messageId !== input.messageId
    || payload.text !== input.text
    || (
      eventPreferredProvider !== undefined
      && input.preferredProvider !== undefined
      && eventPreferredProvider !== input.preferredProvider
    )
  ) {
    throw new Error("Inconsistent discussion.steer.added event");
  }
}

function recoveryInputForSteerEvent(event: TopicEvent): GroupDiscussionReceiveInput {
  const payload = recordValue(event.payload);
  const preferredProvider = steerEventPreferredProvider(event);
  if (
    event.actorPrincipalId === undefined
    || typeof payload?.tenantKey !== "string"
    || typeof payload.chatId !== "string"
    || typeof payload.messageId !== "string"
    || typeof payload.text !== "string"
  ) {
    throw new Error("Inconsistent discussion.steer.added event");
  }
  return {
    tenantKey: payload.tenantKey,
    principalId: event.actorPrincipalId,
    chatId: payload.chatId,
    messageId: payload.messageId,
    text: payload.text,
    sourceAppRole: "hub",
    idempotencyKey: `discussion-steer-event-recovery:${event.topicId}:${event.seq}`,
    ...(preferredProvider === undefined ? {} : { preferredProvider }),
  };
}

function steerEventPreferredProvider(event: TopicEvent): ProviderName | undefined {
  const value = recordValue(event.payload)?.preferredProvider;
  if (
    value !== undefined
    && value !== "claude"
    && value !== "codex"
    && value !== "copilot"
  ) {
    throw new Error("Inconsistent discussion.steer.added event");
  }
  return value;
}

function reconcilePreferredProvider(
  persisted: ProviderName | undefined,
  incoming: ProviderName | undefined,
): ProviderName | undefined {
  if (persisted !== undefined && incoming !== undefined && persisted !== incoming) {
    throw new Error("Conflicting preferred provider for Discussion steer");
  }
  return persisted ?? incoming;
}

function assertSteerReceiptMatchesEvent(
  receipt: DiscussionSteer,
  input: GroupDiscussionReceiveInput,
  discussion: GroupDiscussion,
): void {
  if (
    receipt.discussionId !== discussion.id
    || receipt.messageId !== input.messageId
    || receipt.principalId !== input.principalId
    || receipt.text !== input.text
    || (
      input.preferredProvider !== undefined
      && receipt.preferredProvider !== undefined
      && receipt.preferredProvider !== input.preferredProvider
    )
  ) {
    throw new Error("Inconsistent Discussion steer receipt");
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactLegacyPayloadShape(
  payload: Record<string, unknown> | undefined,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  if (payload === undefined) return false;
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => key in payload)
    && Object.keys(payload).every((key) => allowedKeys.has(key));
}
