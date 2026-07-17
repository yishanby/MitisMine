export type WorkerLeaseStatus = "queued" | "leased" | "completed" | "failed";

export interface WorkerLeasePort {
  lease(taskId: string, workerId: string, now: Date, durationMs: number): void;
  heartbeat(taskId: string, workerId: string, now: Date, durationMs: number): void;
  complete(taskId: string, workerId: string, now: Date): void;
  requeue(taskId: string, workerId: string, now: Date): void;
  fail(taskId: string, workerId: string, now: Date): void;
}

export interface WorkerTaskExecution<T> {
  readonly taskId: string;
  readonly signal?: AbortSignal;
  readonly operation: () => Promise<T>;
}

export interface WorkerTaskExecutorPort {
  execute<T>(input: WorkerTaskExecution<T>): Promise<T>;
}

export interface IntervalScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

interface LocalWorkerTaskExecutorOptions {
  readonly leases: WorkerLeasePort;
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => Date;
  readonly scheduler?: IntervalScheduler;
}

const systemScheduler: IntervalScheduler = {
  setInterval: (callback, delayMs) => {
    const handle = setInterval(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class LocalWorkerTaskExecutor implements WorkerTaskExecutorPort {
  readonly #leases: WorkerLeasePort;
  readonly #workerId: string;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #now: () => Date;
  readonly #scheduler: IntervalScheduler;

  constructor(options: LocalWorkerTaskExecutorOptions) {
    this.#leases = options.leases;
    this.#workerId = options.workerId ?? "local";
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.#now = options.now ?? (() => new Date());
    this.#scheduler = options.scheduler ?? systemScheduler;
    if (!this.#workerId.trim()) throw new Error("Worker ID is required");
    if (this.#leaseDurationMs <= 0 || this.#heartbeatIntervalMs <= 0) {
      throw new Error("Worker lease and heartbeat durations must be positive");
    }
    if (this.#heartbeatIntervalMs >= this.#leaseDurationMs) {
      throw new Error("Worker heartbeat interval must be shorter than the lease duration");
    }
  }

  async execute<T>(input: WorkerTaskExecution<T>): Promise<T> {
    if (!input.taskId.trim()) throw new Error("Worker task ID is required");
    const isAborted = (): boolean => input.signal?.aborted === true;
    if (isAborted()) throw cancellationError();
    this.#leases.lease(
      input.taskId,
      this.#workerId,
      this.#now(),
      this.#leaseDurationMs,
    );
    let active = true;
    const requeue = (): void => {
      if (!active) return;
      this.#leases.requeue(input.taskId, this.#workerId, this.#now());
      active = false;
    };
    const onAbort = (): void => requeue();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const heartbeat = this.#scheduler.setInterval(() => {
      if (!active) return;
      this.#leases.heartbeat(
        input.taskId,
        this.#workerId,
        this.#now(),
        this.#leaseDurationMs,
      );
    }, this.#heartbeatIntervalMs);
    try {
      const result = await input.operation();
      if (isAborted()) {
        requeue();
        throw cancellationError();
      }
      this.#leases.complete(input.taskId, this.#workerId, this.#now());
      active = false;
      return result;
    } catch (error) {
      if (active) {
        if (isAborted()) requeue();
        else {
          this.#leases.fail(input.taskId, this.#workerId, this.#now());
          active = false;
        }
      }
      throw error;
    } finally {
      this.#scheduler.clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function cancellationError(): Error {
  const error = new Error("Worker task cancelled");
  error.name = "AbortError";
  return error;
}
