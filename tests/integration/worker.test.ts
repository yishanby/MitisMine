import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerLeaseStore } from "../../apps/worker/src/main.js";
import type { WorkerLeasePort } from "../../packages/orchestrator/src/worker.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface WorkerTaskExecutor {
  execute<T>(input: {
    readonly taskId: string;
    readonly signal?: AbortSignal;
    readonly operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T>;
}

class ManualIntervalScheduler {
  readonly #callbacks = new Set<() => void>();

  setInterval(callback: () => void): object {
    this.#callbacks.add(callback);
    return callback;
  }

  clearInterval(handle: unknown): void {
    this.#callbacks.delete(handle as () => void);
  }

  tick(): void {
    for (const callback of [...this.#callbacks]) callback();
  }

  get size(): number {
    return this.#callbacks.size;
  }
}

type ExecutorConstructor = new (options: {
  readonly leases: WorkerLeasePort;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly now: () => Date;
  readonly scheduler: ManualIntervalScheduler;
}) => WorkerTaskExecutor;

async function executorConstructor(): Promise<ExecutorConstructor> {
  const module = await import("../../packages/orchestrator/src/worker.js")
    .catch(() => ({})) as Record<string, unknown>;
  expect(typeof module.LocalWorkerTaskExecutor).toBe("function");
  return module.LocalWorkerTaskExecutor as ExecutorConstructor;
}

function leaseHarness(): { directory: string; leases: WorkerLeaseStore } {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-worker-executor-"));
  temporaryDirectories.push(directory);
  return { directory, leases: WorkerLeaseStore.open(join(directory, "leases.db")) };
}

describe("LocalWorkerTaskExecutor", () => {
  it("leases and completes each successful operation", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    const now = new Date("2026-07-17T12:00:00.000Z");
    const executor = new LocalWorkerTaskExecutor({
      leases,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => now,
      scheduler,
    });

    try {
      await expect(executor.execute({
        taskId: "task-success",
        operation: async () => "done",
      })).resolves.toBe("done");
      expect(leases.status("task-success")).toBe("completed");
      expect(leases.history("task-success")).toEqual(["leased", "completed"]);
      expect(scheduler.size).toBe(0);
    } finally {
      leases.close();
    }
  });

  it("returns a durable completed result without running the same task twice", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    const executor = new LocalWorkerTaskExecutor({
      leases,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      scheduler,
    });
    let executions = 0;

    try {
      await expect(executor.execute({
        taskId: "task-cached",
        operation: async () => {
          executions += 1;
          return { answer: "durable" };
        },
      })).resolves.toEqual({ answer: "durable" });
      await expect(executor.execute({
        taskId: "task-cached",
        operation: async () => {
          executions += 1;
          throw new Error("duplicate operation ran");
        },
      })).resolves.toEqual({ answer: "durable" });

      expect(executions).toBe(1);
      expect(leases.history("task-cached")).toEqual(["leased", "completed"]);
    } finally {
      leases.close();
    }
  });

  it("heartbeats long operations with a controllable clock", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    let now = new Date("2026-07-17T12:00:00.000Z");
    let finish: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const executor = new LocalWorkerTaskExecutor({
      leases,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => now,
      scheduler,
    });

    try {
      const running = executor.execute({
        taskId: "task-heartbeat",
        operation: () => operation,
      });
      await Promise.resolve();
      now = new Date("2026-07-17T12:00:00.900Z");
      scheduler.tick();

      expect(leases.requeueExpired(new Date("2026-07-17T12:00:01.500Z"))).toEqual([]);
      expect(leases.status("task-heartbeat")).toBe("leased");
      finish?.();
      await running;
      expect(leases.status("task-heartbeat")).toBe("completed");
    } finally {
      finish?.();
      leases.close();
    }
  });

  it("propagates a heartbeat failure, aborts the operation, and requeues the lease", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    const leasePort: WorkerLeasePort = {
      lease: (...args) => leases.lease(...args),
      heartbeat: () => { throw new Error("heartbeat storage unavailable"); },
      complete: (...args) => leases.complete(...args),
      requeue: (...args) => leases.requeue(...args),
      fail: (...args) => leases.fail(...args),
      completedResult: (taskId) => leases.completedResult(taskId),
    };
    const executor = new LocalWorkerTaskExecutor({
      leases: leasePort,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      scheduler,
    });
    let operationAborted = false;

    try {
      const running = executor.execute({
        taskId: "task-heartbeat-failure",
        operation: (signal) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            operationAborted = true;
            reject(signal.reason);
          }, { once: true });
        }),
      });
      await Promise.resolve();

      expect(() => scheduler.tick()).not.toThrow();
      await expect(running).rejects.toThrow("heartbeat storage unavailable");
      expect(operationAborted).toBe(true);
      expect(leases.status("task-heartbeat-failure")).toBe("queued");
      expect(leases.history("task-heartbeat-failure")).toEqual(["leased", "queued"]);
      expect(scheduler.size).toBe(0);
    } finally {
      leases.close();
    }
  });

  it("marks provider failures failed and clears the heartbeat", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    const executor = new LocalWorkerTaskExecutor({
      leases,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      scheduler,
    });

    try {
      await expect(executor.execute({
        taskId: "task-failed",
        operation: async () => { throw new Error("provider failed"); },
      })).rejects.toThrow("provider failed");
      expect(leases.status("task-failed")).toBe("failed");
      expect(leases.history("task-failed")).toEqual(["leased", "failed"]);
      expect(scheduler.size).toBe(0);
    } finally {
      leases.close();
    }
  });

  it("requeues immediately on cancellation and leaves no active lease", async () => {
    const LocalWorkerTaskExecutor = await executorConstructor();
    const { leases } = leaseHarness();
    const scheduler = new ManualIntervalScheduler();
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const executor = new LocalWorkerTaskExecutor({
      leases,
      workerId: "local",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      scheduler,
    });

    try {
      const running = executor.execute({
        taskId: "task-cancelled",
        signal: controller.signal,
        operation: () => operation,
      });
      await Promise.resolve();
      controller.abort();

      expect(leases.status("task-cancelled")).toBe("queued");
      expect(leases.history("task-cancelled")).toEqual(["leased", "queued"]);
      finish?.();
      await expect(running).rejects.toThrow(/cancelled/i);
      expect(leases.status("task-cancelled")).not.toBe("leased");
      expect(scheduler.size).toBe(0);
    } finally {
      finish?.();
      leases.close();
    }
  });
});
