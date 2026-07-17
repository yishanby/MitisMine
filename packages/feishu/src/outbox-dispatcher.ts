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
  #flushTask: Promise<void> | undefined;

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

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#flushTask;
  }

  flushOnce(): Promise<void> {
    if (this.#flushTask !== undefined) return this.#flushTask;
    const flushTask = this.#performFlush();
    const trackedTask = flushTask.finally(() => {
      if (this.#flushTask === trackedTask) this.#flushTask = undefined;
    });
    this.#flushTask = trackedTask;
    return trackedTask;
  }

  async #performFlush(): Promise<void> {
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
  }
}
