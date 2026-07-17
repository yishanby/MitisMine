import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  OrchestrationCheckpoint,
  OrchestrationRecord,
  OrchestrationStore,
} from "../../orchestrator/src/index.js";
import { SCHEMA_SQL } from "./schema.js";

interface CheckpointRow {
  checkpoint_json: string;
}

interface RecordRow {
  run_id: string;
  topic_id: string;
  type: OrchestrationRecord["type"];
  provider: OrchestrationRecord["provider"];
  phase: OrchestrationRecord["phase"];
  created_at: string;
}

export class SqliteOrchestrationStore implements OrchestrationStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): SqliteOrchestrationStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    return new SqliteOrchestrationStore(database);
  }

  close(): void {
    this.#database.close();
  }

  save(checkpoint: OrchestrationCheckpoint): void {
    this.#database
      .prepare(`
        INSERT INTO orchestration_checkpoints (
          run_id, topic_id, checkpoint_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET
          topic_id = excluded.topic_id,
          checkpoint_json = excluded.checkpoint_json,
          updated_at = excluded.updated_at
      `)
      .run(
        checkpoint.run.id,
        checkpoint.run.topicId,
        JSON.stringify(checkpoint),
        checkpoint.run.updatedAt,
      );
  }

  load(runId: string): OrchestrationCheckpoint | undefined {
    const row = this.#database
      .prepare("SELECT checkpoint_json FROM orchestration_checkpoints WHERE run_id = ?")
      .get(runId) as CheckpointRow | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.checkpoint_json) as OrchestrationCheckpoint);
  }

  record(event: OrchestrationRecord): void {
    this.#database
      .prepare(`
        INSERT INTO orchestration_records (
          run_id, topic_id, type, provider, phase, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.runId,
        event.topicId,
        event.type,
        event.provider,
        event.phase,
        event.createdAt,
      );
  }

  runCount(topicId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM orchestration_checkpoints WHERE topic_id = ?")
      .get(topicId) as { count: number };
    return Number(row.count);
  }

  records(runId: string): OrchestrationRecord[] {
    const rows = this.#database
      .prepare(`
        SELECT run_id, topic_id, type, provider, phase, created_at
        FROM orchestration_records WHERE run_id = ? ORDER BY id
      `)
      .all(runId) as unknown as RecordRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      topicId: row.topic_id,
      type: row.type,
      provider: row.provider,
      phase: row.phase,
      createdAt: row.created_at,
    }));
  }

  nonTerminalRunIds(): string[] {
    const rows = this.#database
      .prepare("SELECT run_id, checkpoint_json FROM orchestration_checkpoints ORDER BY updated_at")
      .all() as unknown as Array<{ run_id: string; checkpoint_json: string }>;
    return rows
      .filter((row) => {
        const checkpoint = JSON.parse(row.checkpoint_json) as OrchestrationCheckpoint;
        return !["completed", "cancelled", "failed", "paused"].includes(checkpoint.run.state);
      })
      .map((row) => row.run_id);
  }

  latestForTopic(topicId: string): OrchestrationCheckpoint | undefined {
    const row = this.#database
      .prepare(`
        SELECT checkpoint_json FROM orchestration_checkpoints
        WHERE topic_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1
      `)
      .get(topicId) as CheckpointRow | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.checkpoint_json) as OrchestrationCheckpoint);
  }
}
