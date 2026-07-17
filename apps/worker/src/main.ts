import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_SQL } from "../../../packages/storage/src/schema.js";

export type WorkerLeaseStatus = "queued" | "leased" | "completed" | "failed";
export type CompletedWorkerResult =
  | { readonly found: false }
  | { readonly found: true; readonly result: unknown };

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
    const leaseColumns = database
      .prepare("PRAGMA table_info(worker_leases)")
      .all() as unknown as Array<{ name: string }>;
    if (!leaseColumns.some((column) => column.name === "result_json")) {
      database.exec("ALTER TABLE worker_leases ADD COLUMN result_json TEXT");
    }
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
          task_id, worker_id, lease_expires_at, last_heartbeat_at, status, result_json
        ) VALUES (?, ?, ?, ?, 'leased', NULL)
        ON CONFLICT (task_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          lease_expires_at = excluded.lease_expires_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          status = 'leased',
          result_json = NULL
        WHERE worker_leases.status = 'queued'
          OR (
            worker_leases.status = 'leased'
            AND worker_leases.lease_expires_at <= excluded.last_heartbeat_at
          )
      `)
      .run(taskId, workerId, expiresAt, now.toISOString());
    if (Number(result.changes) !== 1) {
      const current = this.#database
        .prepare("SELECT status FROM worker_leases WHERE task_id = ?")
        .get(taskId) as { status: WorkerLeaseStatus } | undefined;
      if (current?.status === "completed" || current?.status === "failed") {
        throw new Error(`Task is terminal and not available for leasing: ${current.status}`);
      }
      throw new Error("Task is already leased");
    }
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

  complete(taskId: string, workerId: string, now = new Date(), result?: unknown): void {
    const encoded = JSON.stringify({ result });
    const updated = this.#database
      .prepare(`
        UPDATE worker_leases SET status = 'completed', result_json = ?
        WHERE task_id = ? AND worker_id = ? AND status = 'leased'
      `)
      .run(encoded, taskId, workerId);
    if (Number(updated.changes) !== 1) throw new Error("Active worker lease not found");
    this.#record(taskId, workerId, "completed", now);
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

  completedResult(taskId: string): CompletedWorkerResult {
    const row = this.#database
      .prepare("SELECT status, result_json FROM worker_leases WHERE task_id = ?")
      .get(taskId) as { status: WorkerLeaseStatus; result_json: string | null } | undefined;
    if (row?.status !== "completed" || row.result_json === null) return { found: false };
    const decoded = JSON.parse(row.result_json) as { result?: unknown };
    return { found: true, result: decoded.result };
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
