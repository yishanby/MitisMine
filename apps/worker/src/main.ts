import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_SQL } from "../../../packages/storage/src/schema.js";

export type WorkerLeaseStatus = "queued" | "leased" | "completed" | "failed";

export class WorkerLeaseStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): WorkerLeaseStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    return new WorkerLeaseStore(database);
  }

  close(): void {
    this.#database.close();
  }

  lease(taskId: string, workerId: string, now: Date, durationMs: number): void {
    if (durationMs <= 0) throw new Error("Lease duration must be positive");
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();
    const result = this.#database
      .prepare(`
        INSERT INTO worker_leases (
          task_id, worker_id, lease_expires_at, last_heartbeat_at, status
        ) VALUES (?, ?, ?, ?, 'leased')
        ON CONFLICT (task_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          lease_expires_at = excluded.lease_expires_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          status = 'leased'
        WHERE worker_leases.status != 'leased'
          OR worker_leases.worker_id = excluded.worker_id
          OR worker_leases.lease_expires_at <= excluded.last_heartbeat_at
      `)
      .run(taskId, workerId, expiresAt, now.toISOString());
    if (Number(result.changes) !== 1) throw new Error("Task is already leased by another worker");
    this.#record(taskId, workerId, "leased", now);
  }

  heartbeat(taskId: string, workerId: string, now: Date, durationMs: number): void {
    if (durationMs <= 0) throw new Error("Lease duration must be positive");
    const result = this.#database
      .prepare(`
        UPDATE worker_leases
        SET lease_expires_at = ?, last_heartbeat_at = ?
        WHERE task_id = ? AND worker_id = ? AND status = 'leased'
      `)
      .run(
        new Date(now.getTime() + durationMs).toISOString(),
        now.toISOString(),
        taskId,
        workerId,
      );
    if (Number(result.changes) !== 1) throw new Error("Active worker lease not found");
  }

  requeueExpired(now = new Date()): string[] {
    const rows = this.#database
      .prepare(`
        SELECT task_id, worker_id FROM worker_leases
        WHERE status = 'leased' AND lease_expires_at <= ?
        ORDER BY task_id
      `)
      .all(now.toISOString()) as unknown as Array<{ task_id: string; worker_id: string }>;
    for (const row of rows) {
      this.#transition(row.task_id, row.worker_id, "queued", now);
    }
    return rows.map((row) => row.task_id);
  }

  complete(taskId: string, workerId: string, now = new Date()): void {
    this.#transition(taskId, workerId, "completed", now);
  }

  requeue(taskId: string, workerId: string, now = new Date()): void {
    this.#transition(taskId, workerId, "queued", now);
  }

  fail(taskId: string, workerId: string, now = new Date()): void {
    this.#transition(taskId, workerId, "failed", now);
  }

  status(taskId: string): WorkerLeaseStatus | undefined {
    const row = this.#database
      .prepare("SELECT status FROM worker_leases WHERE task_id = ?")
      .get(taskId) as { status: WorkerLeaseStatus } | undefined;
    return row?.status;
  }

  history(taskId: string): WorkerLeaseStatus[] {
    const rows = this.#database
      .prepare("SELECT status FROM worker_lease_events WHERE task_id = ? ORDER BY id")
      .all(taskId) as unknown as Array<{ status: WorkerLeaseStatus }>;
    return rows.map(({ status }) => status);
  }

  #transition(
    taskId: string,
    workerId: string,
    status: Exclude<WorkerLeaseStatus, "leased">,
    now: Date,
  ): void {
    const result = this.#database
      .prepare(`
        UPDATE worker_leases SET status = ?
        WHERE task_id = ? AND worker_id = ? AND status = 'leased'
      `)
      .run(status, taskId, workerId);
    if (Number(result.changes) !== 1) throw new Error("Active worker lease not found");
    this.#record(taskId, workerId, status, now);
  }

  #record(taskId: string, workerId: string, status: WorkerLeaseStatus, now: Date): void {
    this.#database
      .prepare(`
        INSERT INTO worker_lease_events (task_id, worker_id, status, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(taskId, workerId, status, now.toISOString());
  }
}
