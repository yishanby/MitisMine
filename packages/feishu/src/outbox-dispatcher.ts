import type { DurableOutbox, OutboxMessage } from "../../storage/src/outbox.js";

export interface OutboxSender {
  send(message: OutboxMessage): Promise<void>;
}

interface OutboxDispatcherOptions {
  readonly outbox: DurableOutbox;
  readonly sender: OutboxSender;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
}

export class OutboxDispatcher {
  readonly #outbox: DurableOutbox;
  readonly #sender: OutboxSender;
  readonly #now: () => Date;
  readonly #pollIntervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #flushing = false;

  constructor(options: OutboxDispatcherOptions) {
    this.#outbox = options.outbox;
    this.#sender = options.sender;
    this.#now = options.now ?? (() => new Date());
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.flushOnce(), this.#pollIntervalMs);
    this.#timer.unref();
    void this.flushOnce();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async flushOnce(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const now = this.#now();
      for (const message of this.#outbox.pending(now.toISOString())) {
        try {
          await this.#sender.send(message);
          this.#outbox.markSent(message.id);
        } catch {
          const backoffMs = Math.min(60_000, 1_000 * 2 ** (message.attempts + 1));
          this.#outbox.markRetry(
            message.id,
            new Date(now.getTime() + backoffMs).toISOString(),
          );
        }
      }
    } finally {
      this.#flushing = false;
    }
  }
}
