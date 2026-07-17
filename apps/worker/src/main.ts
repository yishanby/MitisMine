import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_SQL } from "../../../packages/storage/src/schema.js";

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
    this.#database
      .prepare(`
        INSERT INTO worker_leases (
          task_id, worker_id, lease_expires_at, last_heartbeat_at, status
        ) VALUES (?, ?, ?, ?, 'leased')
        ON CONFLICT (task_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          lease_expires_at = excluded.lease_expires_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          status = 'leased'
      `)
      .run(taskId, workerId, expiresAt, now.toISOString());
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
        SELECT task_id FROM worker_leases
        WHERE status = 'leased' AND lease_expires_at <= ?
        ORDER BY task_id
      `)
      .all(now.toISOString()) as unknown as Array<{ task_id: string }>;
    if (rows.length > 0) {
      this.#database
        .prepare(`
          UPDATE worker_leases SET status = 'queued'
          WHERE status = 'leased' AND lease_expires_at <= ?
        `)
        .run(now.toISOString());
    }
    return rows.map((row) => row.task_id);
  }

  status(taskId: string): string | undefined {
    const row = this.#database
      .prepare("SELECT status FROM worker_leases WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    return row?.status;
  }
}
