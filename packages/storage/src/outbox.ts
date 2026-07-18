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
  readonly operation?: OutboxOperation;
  readonly targetMessageId?: string;
  readonly deliveryEffect?: OutboxDeliveryEffect;
}

export type OutboxOperation = "create" | "update";

export interface OutboxDeliveryEffect {
  readonly kind: "discussion.control.created";
  readonly discussionId: string;
}

export interface OutboxSendResult {
  readonly messageId?: string;
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
  readonly operation: OutboxOperation;
  readonly targetMessageId?: string;
  readonly deliveryEffect?: OutboxDeliveryEffect;
  readonly result?: OutboxSendResult;
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
  operation: OutboxOperation;
  target_message_id: string | null;
  delivery_effect_json: string | null;
  result_json: string | null;
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
    const columns = database.prepare("PRAGMA table_info(outbox_messages)").all() as unknown as
      Array<{ name: string }>;
    const addColumn = (name: string, sql: string): void => {
      if (!columns.some((column) => column.name === name)) database.exec(sql);
    };
    addColumn("operation", "ALTER TABLE outbox_messages ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'");
    addColumn("target_message_id", "ALTER TABLE outbox_messages ADD COLUMN target_message_id TEXT");
    addColumn("delivery_effect_json", "ALTER TABLE outbox_messages ADD COLUMN delivery_effect_json TEXT");
    addColumn("result_json", "ALTER TABLE outbox_messages ADD COLUMN result_json TEXT");
    return new DurableOutbox(database);
  }

  close(): void {
    this.#database.close();
  }

  enqueue(input: EnqueueOutboxInput): boolean {
    const operation = input.operation ?? "create";
    const targetMessageId = input.targetMessageId;
    if (operation === "update" && targetMessageId === undefined) {
      throw new Error("Outbox update requires a target message ID");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO outbox_messages (
          id, app_role, receive_id, payload_json, operation,
          target_message_id, delivery_effect_json, result_json, attempts,
          next_attempt_at, status, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 'pending', ?)
      `).run(
        input.id,
        input.appRole,
        input.receiveId,
        JSON.stringify(input.payload),
        operation,
        targetMessageId ?? null,
        input.deliveryEffect === undefined ? null : JSON.stringify(input.deliveryEffect),
        input.nextAttemptAt ?? new Date().toISOString(),
        input.idempotencyKey,
      );
      const inserted = Number(result.changes) === 1;
      if (inserted && operation === "update") {
        this.#database.prepare(`
          UPDATE outbox_messages SET status = 'superseded'
          WHERE operation = 'update' AND target_message_id = ? AND id <> ?
            AND status IN ('pending', 'retry', 'delivered')
        `).run(targetMessageId as string, input.id);
      }
      this.#database.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(now = new Date().toISOString()): OutboxMessage[] {
    const rows = this.#database
      .prepare(`
        SELECT id, app_role, receive_id, payload_json, operation,
               target_message_id, delivery_effect_json, result_json, attempts,
               next_attempt_at, status, idempotency_key
        FROM outbox_messages
        WHERE status IN ('pending', 'retry', 'delivered') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, id
      `)
      .all(now) as unknown as OutboxRow[];
    return rows.map(mapRow);
  }

  markSent(id: string): void {
    this.#database.prepare(`
      UPDATE outbox_messages SET status = 'sent' WHERE id = ? AND status <> 'superseded'
    `).run(id);
  }

  markDelivered(id: string, result: OutboxSendResult): void {
    this.#database.prepare(`
      UPDATE outbox_messages SET status = 'delivered', result_json = ?
      WHERE id = ? AND status <> 'superseded'
    `).run(JSON.stringify(result), id);
  }

  markRetry(id: string, nextAttemptAt: string): void {
    this.#database
      .prepare(`
        UPDATE outbox_messages
        SET status = CASE WHEN status = 'delivered' THEN 'delivered' ELSE 'retry' END,
            attempts = attempts + 1, next_attempt_at = ?
        WHERE id = ? AND status <> 'superseded'
      `)
      .run(nextAttemptAt, id);
  }

  message(id: string): OutboxMessage | undefined {
    const row = this.#database.prepare(`
      SELECT id, app_role, receive_id, payload_json, operation,
             target_message_id, delivery_effect_json, result_json, attempts,
             next_attempt_at, status, idempotency_key
      FROM outbox_messages WHERE id = ?
    `).get(id) as OutboxRow | undefined;
    return row === undefined ? undefined : mapRow(row);
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
    operation: row.operation,
    ...(row.target_message_id === null ? {} : { targetMessageId: row.target_message_id }),
    ...(row.delivery_effect_json === null
      ? {}
      : { deliveryEffect: parseDeliveryEffect(row.delivery_effect_json) }),
    ...(row.result_json === null ? {} : { result: parseSendResult(row.result_json) }),
  };
}

function parseDeliveryEffect(json: string): OutboxDeliveryEffect {
  const value = JSON.parse(json) as Partial<OutboxDeliveryEffect>;
  if (value.kind !== "discussion.control.created" || typeof value.discussionId !== "string") {
    throw new Error("Stored Outbox delivery effect is invalid");
  }
  return { kind: value.kind, discussionId: value.discussionId };
}

function parseSendResult(json: string): OutboxSendResult {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored Outbox send result is invalid");
  }
  const messageId = (value as { messageId?: unknown }).messageId;
  if (messageId !== undefined && typeof messageId !== "string") {
    throw new Error("Stored Outbox message ID is invalid");
  }
  return messageId === undefined ? {} : { messageId };
}
