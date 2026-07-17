export interface RecoveryScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RecoveryOptions {
  readonly leases: { requeueExpired(now?: Date): string[] };
  readonly checkpoints: { nonTerminalRunIds(): string[] };
  readonly orchestrator: {
    resume(runId: string): Promise<unknown>;
    cancel(runId: string): Promise<void>;
  };
  readonly intervalMs?: number;
  readonly scheduler?: RecoveryScheduler;
  readonly onError?: (runId: string | undefined, error: unknown) => void;
}

const systemScheduler: RecoveryScheduler = {
  setInterval: (callback, delayMs) => {
    const handle = setInterval(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class RecoverySupervisor {
  readonly #leases: RecoveryOptions["leases"];
  readonly #checkpoints: RecoveryOptions["checkpoints"];
  readonly #orchestrator: RecoveryOptions["orchestrator"];
  readonly #intervalMs: number;
  readonly #scheduler: RecoveryScheduler;
  readonly #onError: NonNullable<RecoveryOptions["onError"]>;
  readonly #inFlight = new Map<string, Promise<void>>();
  #interval: unknown | undefined;

  constructor(options: RecoveryOptions) {
    this.#leases = options.leases;
    this.#checkpoints = options.checkpoints;
    this.#orchestrator = options.orchestrator;
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#onError = options.onError ?? reportRecoveryError;
    if (this.#intervalMs <= 0) throw new Error("Recovery interval must be positive");
  }

  start(): void {
    if (this.#interval !== undefined) return;
    this.#interval = this.#scheduler.setInterval(() => {
      void this.runOnce();
    }, this.#intervalMs);
  }

  async runOnce(): Promise<void> {
    let runIds: string[];
    try {
      this.#leases.requeueExpired();
      runIds = this.#checkpoints.nonTerminalRunIds();
    } catch (error) {
      this.#report(undefined, error);
      return;
    }
    await Promise.all(runIds.map(async (runId) => this.#resumeOnce(runId)));
  }

  async stop(): Promise<void> {
    if (this.#interval !== undefined) {
      this.#scheduler.clearInterval(this.#interval);
      this.#interval = undefined;
    }
    const runIds = [...this.#inFlight.keys()];
    await Promise.allSettled(runIds.map(async (runId) => this.#orchestrator.cancel(runId)));
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async #resumeOnce(runId: string): Promise<void> {
    const existing = this.#inFlight.get(runId);
    if (existing !== undefined) return existing;
    const execution = this.#orchestrator.resume(runId)
      .then(() => undefined)
      .catch((error: unknown) => { this.#report(runId, error); })
      .finally(() => { this.#inFlight.delete(runId); });
    this.#inFlight.set(runId, execution);
    await execution;
  }

  #report(runId: string | undefined, error: unknown): void {
    try {
      this.#onError(runId, error);
    } catch {
      // Recovery must remain retryable even if an observability callback fails.
    }
  }
}

function reportRecoveryError(runId: string | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown recovery failure";
  console.error(JSON.stringify({ event: "control-plane.recovery-failed", runId, message }));
}
