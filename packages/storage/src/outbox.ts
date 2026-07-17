import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_SQL } from "./schema.js";

export interface EnqueueOutboxInput {
  readonly id: string;
  readonly appRole: string;
  readonly receiveId: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly nextAttemptAt?: string;
}

export interface OutboxMessage {
  readonly id: string;
  readonly appRole: string;
  readonly receiveId: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly status: string;
  readonly idempotencyKey: string;
}

export interface OutboxPort {
  enqueue(input: EnqueueOutboxInput): boolean;
}

interface OutboxRow {
  id: string;
  app_role: string;
  receive_id: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: string;
  status: string;
  idempotency_key: string;
}

export class DurableOutbox implements OutboxPort {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): DurableOutbox {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    return new DurableOutbox(database);
  }

  close(): void {
    this.#database.close();
  }

  enqueue(input: EnqueueOutboxInput): boolean {
    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO outbox_messages (
          id, app_role, receive_id, payload_json, attempts,
          next_attempt_at, status, idempotency_key
        ) VALUES (?, ?, ?, ?, 0, ?, 'pending', ?)
      `)
      .run(
        input.id,
        input.appRole,
        input.receiveId,
        JSON.stringify(input.payload),
        input.nextAttemptAt ?? new Date().toISOString(),
        input.idempotencyKey,
      );
    return Number(result.changes) === 1;
  }

  pending(now = new Date().toISOString()): OutboxMessage[] {
    const rows = this.#database
      .prepare(`
        SELECT id, app_role, receive_id, payload_json, attempts,
               next_attempt_at, status, idempotency_key
        FROM outbox_messages
        WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, id
      `)
      .all(now) as unknown as OutboxRow[];
    return rows.map(mapRow);
  }

  markSent(id: string): void {
    this.#database.prepare("UPDATE outbox_messages SET status = 'sent' WHERE id = ?").run(id);
  }

  markRetry(id: string, nextAttemptAt: string): void {
    this.#database
      .prepare(`
        UPDATE outbox_messages
        SET status = 'retry', attempts = attempts + 1, next_attempt_at = ?
        WHERE id = ?
      `)
      .run(nextAttemptAt, id);
  }
}

function mapRow(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    appRole: row.app_role,
    receiveId: row.receive_id,
    payload: JSON.parse(row.payload_json) as unknown,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    status: row.status,
    idempotencyKey: row.idempotency_key,
  };
}
