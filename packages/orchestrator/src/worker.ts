export type WorkerLeaseStatus = "queued" | "leased" | "completed" | "failed";

export interface WorkerLeasePort {
  lease(taskId: string, workerId: string, now: Date, durationMs: number): void;
  heartbeat(taskId: string, workerId: string, now: Date, durationMs: number): void;
  complete(taskId: string, workerId: string, now: Date, result?: unknown): void;
  requeue(taskId: string, workerId: string, now: Date): void;
  fail(taskId: string, workerId: string, now: Date): void;
  completedResult?(taskId: string):
    | { readonly found: false }
    | { readonly found: true; readonly result: unknown };
}

export interface WorkerTaskExecution<T> {
  readonly taskId: string;
  readonly signal?: AbortSignal;
  readonly operation: (signal: AbortSignal) => Promise<T>;
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
    const cached = this.#leases.completedResult?.(input.taskId);
    if (cached?.found === true) return cached.result as T;
    try {
      this.#leases.lease(
        input.taskId,
        this.#workerId,
        this.#now(),
        this.#leaseDurationMs,
      );
    } catch (error) {
      const racedResult = this.#leases.completedResult?.(input.taskId);
      if (racedResult?.found === true) return racedResult.result as T;
      throw error;
    }
    let active = true;
    const operationController = new AbortController();
    let rejectInterruption: (reason: unknown) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const transition = (kind: "requeue" | "fail"): unknown | undefined => {
      if (!active) return undefined;
      try {
        this.#leases[kind](input.taskId, this.#workerId, this.#now());
        return undefined;
      } catch (error) {
        return error;
      } finally {
        active = false;
      }
    };
    const interrupt = (error: unknown, kind: "requeue" | "fail"): void => {
      if (!active) return;
      const transitionError = transition(kind);
      const propagated = transitionError === undefined
        ? error
        : new AggregateError([error, transitionError], errorMessage(error));
      rejectInterruption(propagated);
      operationController.abort(propagated);
    };
    const onAbort = (): void => interrupt(cancellationError(), "requeue");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const heartbeat = this.#scheduler.setInterval(() => {
      if (!active) return;
      try {
        this.#leases.heartbeat(
          input.taskId,
          this.#workerId,
          this.#now(),
          this.#leaseDurationMs,
        );
      } catch (error) {
        interrupt(error, "requeue");
      }
    }, this.#heartbeatIntervalMs);
    try {
      const result = await Promise.race([input.operation(operationController.signal), interrupted]);
      if (isAborted()) {
        interrupt(cancellationError(), "requeue");
        throw cancellationError();
      }
      this.#leases.complete(input.taskId, this.#workerId, this.#now(), result);
      active = false;
      return result;
    } catch (error) {
      if (active) {
        const transitionError = transition(isAborted() ? "requeue" : "fail");
        if (transitionError !== undefined) {
          throw new AggregateError([error, transitionError], errorMessage(error));
        }
      }
      throw error;
    } finally {
      this.#scheduler.clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Worker task interrupted";
}

function cancellationError(): Error {
  const error = new Error("Worker task cancelled");
  error.name = "AbortError";
  return error;
}
