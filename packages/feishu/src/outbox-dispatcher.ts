import type {
  DurableOutbox,
  OutboxMessage,
  OutboxSendResult,
} from "../../storage/src/outbox.js";

export type { OutboxSendResult } from "../../storage/src/outbox.js";

export interface OutboxSender {
  send(message: OutboxMessage): Promise<OutboxSendResult | void>;
}

export interface OutboxDeliveryEffects {
  apply(message: OutboxMessage, result: OutboxSendResult): Promise<void> | void;
}

interface OutboxDispatcherOptions {
  readonly outbox: DurableOutbox;
  readonly sender: OutboxSender;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly deliveryEffects?: OutboxDeliveryEffects;
}

export class OutboxDispatcher {
  readonly #outbox: DurableOutbox;
  readonly #sender: OutboxSender;
  readonly #now: () => Date;
  readonly #pollIntervalMs: number;
  readonly #deliveryEffects: OutboxDeliveryEffects | undefined;
  #timer: NodeJS.Timeout | undefined;
  #flushTask: Promise<void> | undefined;

  constructor(options: OutboxDispatcherOptions) {
    this.#outbox = options.outbox;
    this.#sender = options.sender;
    this.#now = options.now ?? (() => new Date());
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#deliveryEffects = options.deliveryEffects;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.flushOnce(), this.#pollIntervalMs);
    this.#timer.unref();
    void this.flushOnce();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#flushTask;
  }

  flushOnce(now?: Date): Promise<void> {
    if (this.#flushTask !== undefined) return this.#flushTask;
    const flushTask = this.#performFlush(now ?? this.#now());
    const trackedTask = flushTask.finally(() => {
      if (this.#flushTask === trackedTask) this.#flushTask = undefined;
    });
    this.#flushTask = trackedTask;
    return trackedTask;
  }

  async #performFlush(now: Date): Promise<void> {
    for (const message of this.#outbox.pending(now.toISOString())) {
      try {
        let result = message.result ?? {};
        if (message.status !== "delivered") {
          result = await this.#sender.send(message) ?? {};
          this.#outbox.markDelivered(message.id, result);
        }
        if (message.deliveryEffect !== undefined) {
          if (this.#deliveryEffects === undefined) {
            throw new Error("Outbox delivery effect handler is not configured");
          }
          await this.#deliveryEffects.apply(message, result);
        }
        this.#outbox.markSent(message.id);
      } catch {
        const backoffMs = Math.min(60_000, 1_000 * 2 ** (message.attempts + 1));
        this.#outbox.markRetry(
          message.id,
          new Date(now.getTime() + backoffMs).toISOString(),
        );
      }
    }
  }
}
