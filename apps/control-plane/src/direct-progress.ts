import type { AgentEvent } from "../../../packages/agent-protocol/src/types.js";
import type { ProviderName } from "../../../packages/agent-adapters/src/types.js";
import { textCard } from "../../../packages/feishu/src/cards.js";
import type { DurableOutbox } from "../../../packages/storage/src/outbox.js";

const MIN_UPDATE_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const MAX_PREVIEW_CHARACTERS = 600;

export interface DirectProgressReporterOptions {
  readonly outbox: DurableOutbox;
  readonly dispatchIdempotencyKey: string;
  readonly appRole: string;
  readonly receiveId: string;
  readonly provider: ProviderName;
  readonly now?: () => number;
}

export class DirectProgressReporter {
  readonly #outbox: DurableOutbox;
  readonly #dispatchIdempotencyKey: string;
  readonly #appRole: string;
  readonly #receiveId: string;
  readonly #provider: ProviderName;
  readonly #now: () => number;
  readonly #startedAt: number;
  #lastPublishedAt = Number.NEGATIVE_INFINITY;
  #stage = "任务已进入队列";
  #preview = "";
  #sequence = 0;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: DirectProgressReporterOptions) {
    this.#outbox = options.outbox;
    this.#dispatchIdempotencyKey = options.dispatchIdempotencyKey;
    this.#appRole = options.appRole;
    this.#receiveId = options.receiveId;
    this.#provider = options.provider;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
  }

  start(): void {
    this.#publish("running", true);
    this.#heartbeat = setInterval(() => { this.#publish("running", true); }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  onEvent(event: AgentEvent): void {
    if (event.type === "session") {
      this.#stage = "Session 已建立，正在分析问题";
    } else if (
      event.type === "progress"
      && typeof event.message === "string"
      && !event.message.includes("\ufffd")
    ) {
      this.#stage = truncate(event.message, 120);
    } else if (
      event.type === "delta"
      && typeof event.text === "string"
      && !event.text.includes("\ufffd")
    ) {
      this.#preview = truncate(`${this.#preview}${event.text}`, MAX_PREVIEW_CHARACTERS, true);
    } else {
      return;
    }
    this.#publish("running", false);
  }

  complete(): void {
    this.#stage = "处理完成";
    this.#publish("completed", true);
    this.stop();
  }

  fail(): void {
    this.#stage = "处理失败";
    this.#publish("failed", true);
    this.stop();
  }

  stop(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #publish(state: "running" | "completed" | "failed", force: boolean): void {
    const now = this.#now();
    if (!force && now - this.#lastPublishedAt < MIN_UPDATE_MS) return;
    try {
      const acceptedId = `outbox:${this.#dispatchIdempotencyKey}:accepted`;
      const targetMessageId = this.#outbox.message(acceptedId)?.result?.messageId;
      if (targetMessageId === undefined) return;
      const sequence = this.#sequence + 1;
      const elapsedSeconds = Math.max(0, Math.floor((now - this.#startedAt) / 1_000));
      const content = [
        `**状态**：${stateLabel(state)}`,
        `**当前步骤**：${this.#stage}`,
        ...(this.#preview ? [`**阶段结果**：${this.#preview}`] : []),
        `**已运行**：${elapsedSeconds} 秒`,
      ].join("\n");
      const id = `outbox:${this.#dispatchIdempotencyKey}:progress:${sequence}`;
      const inserted = this.#outbox.enqueue({
        id,
        appRole: this.#appRole,
        receiveId: this.#receiveId,
        payload: textCard(`${providerLabel(this.#provider)} · ${stateLabel(state)}`, content),
        idempotencyKey: `dispatch:${this.#dispatchIdempotencyKey}:progress:${sequence}`,
        operation: "update",
        targetMessageId,
      });
      if (!inserted) return;
      this.#sequence = sequence;
      this.#lastPublishedAt = now;
    } catch {
      // Progress delivery is best-effort and must never fail the provider turn.
    }
  }
}

function providerLabel(provider: ProviderName): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Copilot";
}

function stateLabel(state: "running" | "completed" | "failed"): string {
  if (state === "completed") return "处理完成";
  if (state === "failed") return "处理失败";
  return "处理中";
}

function truncate(value: string, limit: number, keepTail = false): string {
  const characters = [...value];
  if (characters.length <= limit) return value;
  const selected = keepTail ? characters.slice(-limit) : characters.slice(0, limit);
  return keepTail ? `…${selected.join("")}` : `${selected.join("")}…`;
}
