import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AdapterRegistry,
  AgentTask,
  ProviderName,
} from "../../agent-adapters/src/index.js";
import {
  completeDiscussionTurn,
  nextDiscussionProvider,
  shouldSummarize,
  transitionDiscussion,
  type GroupDiscussion,
} from "../../domain/src/discussion.js";
import { discussionCard, textCard } from "../../feishu/src/cards.js";
import type { OutboxPort } from "../../storage/src/outbox.js";
import {
  type DiscussionTurn,
  SqliteDiscussionStore,
} from "../../storage/src/discussion.js";
import type { EventStore } from "../../storage/src/store.js";
import { discussionSummaryPrompt, discussionTurnPrompt } from "./prompts.js";

export interface DiscussionCoordinatorOptions {
  readonly store: SqliteDiscussionStore;
  readonly events: EventStore;
  readonly outbox: OutboxPort;
  readonly adapters: AdapterRegistry;
  readonly workspaceRoot: string;
  readonly idFactory: () => string;
  readonly maxConcurrency?: number;
}

interface DiscussionAgentOutput {
  readonly message: string;
  readonly continueDiscussion: boolean;
  readonly openQuestions: readonly string[];
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
      await new Promise<void>((resolveWaiting) => this.#waiting.push(resolveWaiting));
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

export class DiscussionCoordinator {
  readonly #store: SqliteDiscussionStore;
  readonly #events: EventStore;
  readonly #outbox: OutboxPort;
  readonly #adapters: AdapterRegistry;
  readonly #workspaceRoot: string;
  readonly #idFactory: () => string;
  readonly #semaphore: Semaphore;
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
    this.#semaphore = new Semaphore(options.maxConcurrency ?? 3);
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
      await this.refreshControl(discussionId);
      if (discussion.state === "active") {
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
    const turnId = this.#idFactory();
    const claimed = this.#store.claimTurn({
      id: turnId,
      discussionId: discussion.id,
      provider,
      round: discussion.round,
      turnIndex: discussion.turnIndex,
    });
    if (!claimed) throw new Error("Discussion turn index was already claimed");
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
      this.#events.append({
        topicId: discussion.topicId,
        type: "discussion.agent.completed",
        payload: {
          discussionId: discussion.id,
          turnId,
          provider,
          round: discussion.round,
          text: output.message,
          continueDiscussion: output.continueDiscussion,
          openQuestions: output.openQuestions,
        },
        idempotencyKey: `discussion:${discussion.id}:turn:${discussion.turnIndex}:completed`,
      });
      this.#outbox.enqueue({
        id: `outbox:discussion:${discussion.id}:visible:${discussion.turnIndex}`,
        appRole: provider,
        receiveId: discussion.chatId,
        payload: textCard(`${providerLabel(provider)} · 第 ${discussion.round} 轮`, output.message),
        idempotencyKey: `discussion:${discussion.id}:visible:${discussion.turnIndex}`,
      });
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
