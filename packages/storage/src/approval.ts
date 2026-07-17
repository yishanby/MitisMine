import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ApprovalStore,
  ApprovalStatus,
  StoredApprovalRequest,
} from "../../approval/src/index.js";
import { SCHEMA_SQL } from "./schema.js";

interface ApprovalRow {
  id: string;
  topic_id: string;
  principal_id: string;
  action_json: string;
  action_hash: string;
  status: ApprovalStatus;
  expires_at: string;
  idempotency_key: string;
  result_json: string | null;
}

interface StoredEnvelope {
  requesterPrincipalId: string;
  approverPrincipalId: string;
  action: StoredApprovalRequest["action"];
}

export class SqliteApprovalStore implements ApprovalStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): SqliteApprovalStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    database
      .prepare("UPDATE approval_requests SET status = 'pending' WHERE status = 'executing'")
      .run();
    return new SqliteApprovalStore(database);
  }

  close(): void {
    this.#database.close();
  }

  create(request: StoredApprovalRequest): void {
    const envelope: StoredEnvelope = {
      requesterPrincipalId: request.requesterPrincipalId,
      approverPrincipalId: request.approverPrincipalId,
      action: request.action,
    };
    this.#database
      .prepare(`
        INSERT INTO approval_requests (
          id, topic_id, principal_id, action_json, action_hash,
          status, expires_at, idempotency_key, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        request.id,
        request.topicId,
        request.approverPrincipalId,
        JSON.stringify(envelope),
        request.actionHash,
        request.status,
        request.expiresAt,
        request.idempotencyKey,
      );
  }

  get(id: string): StoredApprovalRequest | undefined {
    const row = this.#database
      .prepare(`
        SELECT id, topic_id, principal_id, action_json, action_hash,
               status, expires_at, idempotency_key, result_json
        FROM approval_requests WHERE id = ?
      `)
      .get(id) as ApprovalRow | undefined;
    if (row === undefined) return undefined;
    const envelope = JSON.parse(row.action_json) as StoredEnvelope;
    const storedResult = row.result_json === null
      ? undefined
      : (JSON.parse(row.result_json) as { result?: unknown; error?: string });
    return {
      id: row.id,
      topicId: row.topic_id,
      requesterPrincipalId: envelope.requesterPrincipalId,
      approverPrincipalId: envelope.approverPrincipalId,
      action: envelope.action,
      actionHash: row.action_hash,
      idempotencyKey: row.idempotency_key,
      expiresAt: row.expires_at,
      status: row.status,
      ...(storedResult?.result === undefined ? {} : { result: storedResult.result }),
      ...(storedResult?.error === undefined ? {} : { error: storedResult.error }),
    };
  }

  beginExecution(id: string): boolean {
    const result = this.#database
      .prepare("UPDATE approval_requests SET status = 'executing' WHERE id = ? AND status = 'pending'")
      .run(id);
    return Number(result.changes) === 1;
  }

  complete(id: string, result: unknown): void {
    const updated = this.#database
      .prepare(`
        UPDATE approval_requests SET status = 'completed', result_json = ?
        WHERE id = ? AND status = 'executing'
      `)
      .run(JSON.stringify({ result }), id);
    if (Number(updated.changes) !== 1) throw new Error("Approval is not executing");
  }

  fail(id: string, message: string): void {
    this.#database
      .prepare("UPDATE approval_requests SET status = 'failed', result_json = ? WHERE id = ?")
      .run(JSON.stringify({ error: message }), id);
  }

  expire(id: string): void {
    this.#database
      .prepare("UPDATE approval_requests SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(id);
  }
}
