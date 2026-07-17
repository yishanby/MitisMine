import type { FastifyInstance } from "fastify";

import { APP_ROLES, type AppRole } from "../../../packages/feishu/src/registry.js";

export class AppConnectionRegistry {
  readonly #connected = new Set<AppRole>();

  connect(role: AppRole): void {
    this.#connected.add(role);
  }

  disconnect(role: AppRole): void {
    this.#connected.delete(role);
  }

  isReady(): boolean {
    return APP_ROLES.every((role) => this.#connected.has(role));
  }

  roles(): AppRole[] {
    return APP_ROLES.filter((role) => this.#connected.has(role));
  }
}

export class WorkerRegistry {
  readonly #workers = new Map<string, number>();
  readonly #persistent = new Set<string>();
  readonly #staleAfterMs: number;

  constructor(staleAfterMs = 30_000) {
    this.#staleAfterMs = staleAfterMs;
  }

  connect(workerId: string, now = new Date()): void {
    if (!workerId.trim()) throw new Error("Worker ID is required");
    this.#workers.set(workerId, now.getTime());
  }

  connectPersistent(workerId: string): void {
    if (!workerId.trim()) throw new Error("Worker ID is required");
    this.#persistent.add(workerId);
  }

  heartbeat(workerId: string, now = new Date()): void {
    if (!this.#workers.has(workerId)) throw new Error(`Worker not connected: ${workerId}`);
    this.#workers.set(workerId, now.getTime());
  }

  disconnect(workerId: string): void {
    this.#workers.delete(workerId);
    this.#persistent.delete(workerId);
  }

  connectedCount(now = new Date()): number {
    const oldest = now.getTime() - this.#staleAfterMs;
    return this.#persistent.size + [...this.#workers.entries()].filter(
      ([workerId, lastSeen]) => !this.#persistent.has(workerId) && lastSeen >= oldest,
    ).length;
  }
}

export interface HealthDependencies {
  readonly storeHealthy: () => boolean;
  readonly apps: AppConnectionRegistry;
  readonly workers: WorkerRegistry;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_request, reply) => {
    const details = {
      store: deps.storeHealthy(),
      apps: deps.apps.roles(),
      workers: deps.workers.connectedCount(),
    };
    const ready = details.store && deps.apps.isReady() && details.workers > 0;
    return reply.code(ready ? 200 : 503).send({ ready, ...details });
  });
}
