import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProviderName } from "../../agent-adapters/src/index.js";
import type { GroupDiscussion } from "../../domain/src/discussion.js";
import { SCHEMA_SQL } from "./schema.js";

export type DiscussionSteerStatus = "pending" | "consumed";
export type DiscussionTurnState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface DiscussionSteer {
  readonly id: string;
  readonly discussionId: string;
  readonly messageId: string;
  readonly topicEventSeq: number;
  readonly principalId: string;
  readonly text: string;
  readonly preferredProvider?: ProviderName;
  readonly status: DiscussionSteerStatus;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

export interface DiscussionSteerInput {
  readonly id: string;
  readonly discussionId: string;
  readonly messageId: string;
  readonly topicEventSeq?: number;
  readonly principalId: string;
  readonly text: string;
  readonly preferredProvider?: ProviderName;
  readonly createdAt?: string;
}

export interface DiscussionTurn {
  readonly id: string;
  readonly discussionId: string;
  readonly provider: ProviderName;
  readonly round: number;
  readonly turnIndex: number;
  readonly state: DiscussionTurnState;
  readonly externalSessionId?: string;
  readonly text?: string;
  readonly continueDiscussion?: boolean;
  readonly openQuestions: readonly string[];
  readonly steerIds: readonly string[];
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface ClaimDiscussionTurnInput {
  readonly id: string;
  readonly discussionId: string;
  readonly provider: ProviderName;
  readonly round: number;
  readonly turnIndex: number;
  readonly steerIds?: readonly string[];
  readonly startedAt?: string;
}

export interface CompleteDiscussionTurnInput {
  readonly id: string;
  readonly externalSessionId: string;
  readonly text: string;
  readonly continueDiscussion: boolean;
  readonly openQuestions: readonly string[];
  readonly completedAt?: string;
}

export type FinalizeDiscussionSummaryResult =
  | { readonly status: "completed"; readonly discussion: GroupDiscussion }
  | { readonly status: "retry" }
  | { readonly status: "inactive" };

interface DiscussionRow {
  id: string;
  topic_id: string;
  tenant_key: string;
  chat_id: string;
  question: string;
  starter_principal_id: string;
  state: GroupDiscussion["state"];
  round: number;
  turn_index: number;
  next_provider: ProviderName;
  round_order_json: string;
  max_rounds: number;
  version: number;
  evaluated_turn_index: number;
  start_message_id: string | null;
  preferred_provider: ProviderName | null;
  control_message_id: string | null;
  active_turn_id: string | null;
  summary_text: string | null;
  created_at: string;
  updated_at: string;
}

interface SteerRow {
  id: string;
  discussion_id: string;
  message_id: string;
  topic_event_seq: number;
  principal_id: string;
  text: string;
  preferred_provider: ProviderName | null;
  status: DiscussionSteerStatus;
  created_at: string;
  consumed_at: string | null;
}

interface TurnRow {
  id: string;
  discussion_id: string;
  provider: ProviderName;
  round: number;
  turn_index: number;
  state: DiscussionTurnState;
  external_session_id: string | null;
  text: string | null;
  continue_discussion: number | null;
  open_questions_json: string;
  steer_ids_json: string;
  started_at: string | null;
  completed_at: string | null;
}

export class SqliteDiscussionStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): SqliteDiscussionStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    const turnColumns = database.prepare("PRAGMA table_info(discussion_turns)").all() as unknown as
      Array<{ name: string }>;
    if (!turnColumns.some(({ name }) => name === "steer_ids_json")) {
      database.exec("ALTER TABLE discussion_turns ADD COLUMN steer_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    const discussionColumns = database.prepare("PRAGMA table_info(group_discussions)").all() as unknown as
      Array<{ name: string }>;
    if (!discussionColumns.some(({ name }) => name === "summary_text")) {
      database.exec("ALTER TABLE group_discussions ADD COLUMN summary_text TEXT");
    }
    if (!discussionColumns.some(({ name }) => name === "start_message_id")) {
      database.exec("ALTER TABLE group_discussions ADD COLUMN start_message_id TEXT");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const migrationColumns = database.prepare("PRAGMA table_info(group_discussions)").all() as unknown as
        Array<{ name: string }>;
      const legacyEvaluatedBoundary = !migrationColumns.some(
        ({ name }) => name === "evaluated_turn_index",
      );
      if (legacyEvaluatedBoundary) {
        database.exec(
          "ALTER TABLE group_discussions ADD COLUMN evaluated_turn_index INTEGER NOT NULL DEFAULT 0",
        );
        database.exec(`
          UPDATE group_discussions
          SET evaluated_turn_index = turn_index
          WHERE state = 'paused'
            AND turn_index > 0
            AND turn_index % 3 = 0
            AND evaluated_turn_index = 0
        `);
      }
      database.prepare(`
        INSERT OR IGNORE INTO schema_migrations (migration_key, applied_at)
        VALUES ('discussion_evaluated_turn_backfill_v1', ?)
      `).run(new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS group_discussions_start_message_idx
      ON group_discussions (start_message_id)
      WHERE start_message_id IS NOT NULL
    `);
    return new SqliteDiscussionStore(database);
  }

  close(): void {
    this.#database.close();
  }

  bindChatTopic(tenantKey: string, chatId: string, topicId: string, now = new Date().toISOString()): void {
    this.#database.prepare(`
      INSERT INTO group_chat_topics (tenant_key, chat_id, topic_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_key, chat_id) DO UPDATE SET
        topic_id = excluded.topic_id,
        updated_at = excluded.updated_at
    `).run(tenantKey, chatId, topicId, now);
  }

  chatTopic(tenantKey: string, chatId: string): string | undefined {
    const row = this.#database.prepare(`
      SELECT topic_id FROM group_chat_topics WHERE tenant_key = ? AND chat_id = ?
    `).get(tenantKey, chatId) as { topic_id: string } | undefined;
    return row?.topic_id;
  }

  createDiscussion(discussion: GroupDiscussion): GroupDiscussion {
    try {
      this.#database.prepare(`
        INSERT INTO group_discussions (
          id, topic_id, tenant_key, chat_id, question, starter_principal_id,
          state, round, turn_index, next_provider, round_order_json, max_rounds, version,
          evaluated_turn_index, start_message_id, preferred_provider, control_message_id,
          active_turn_id, summary_text,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        discussion.id,
        discussion.topicId,
        discussion.tenantKey,
        discussion.chatId,
        discussion.question,
        discussion.starterPrincipalId,
        discussion.state,
        discussion.round,
        discussion.turnIndex,
        discussion.nextProvider,
        JSON.stringify(discussion.roundOrder),
        discussion.maxRounds,
        discussion.version,
        discussion.evaluatedTurnIndex,
        discussion.startMessageId ?? null,
        discussion.preferredProvider ?? null,
        discussion.controlMessageId ?? null,
        discussion.activeTurnId ?? null,
        discussion.summaryText ?? null,
        discussion.createdAt,
        discussion.updatedAt,
      );
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "UNIQUE constraint failed: group_discussions.start_message_id"
        && discussion.startMessageId !== undefined
      ) {
        const existing = this.discussionForStartMessage(discussion.startMessageId);
        if (existing !== undefined && sameDiscussionStart(existing, discussion)) return existing;
        throw new Error("Discussion start message conflicts with another Discussion");
      }
      if (
        error instanceof Error
        && error.message === (
          "UNIQUE constraint failed: group_discussions.tenant_key, group_discussions.chat_id"
        )
      ) {
        throw new Error("This group already has an active Discussion");
      }
      throw error;
    }
    return this.discussion(discussion.id) as GroupDiscussion;
  }

  discussion(id: string): GroupDiscussion | undefined {
    const row = this.#database.prepare(`${DISCUSSION_SELECT} WHERE id = ?`).get(id) as
      | DiscussionRow
      | undefined;
    return row === undefined ? undefined : mapDiscussion(row);
  }

  discussionForStartMessage(messageId: string): GroupDiscussion | undefined {
    const row = this.#database.prepare(`
      ${DISCUSSION_SELECT} WHERE start_message_id = ?
    `).get(messageId) as DiscussionRow | undefined;
    return row === undefined ? undefined : mapDiscussion(row);
  }

  activeForChat(tenantKey: string, chatId: string): GroupDiscussion | undefined {
    const row = this.#database.prepare(`
      ${DISCUSSION_SELECT}
      WHERE tenant_key = ? AND chat_id = ?
        AND state IN ('active', 'paused', 'summarizing')
      LIMIT 1
    `).get(tenantKey, chatId) as DiscussionRow | undefined;
    return row === undefined ? undefined : mapDiscussion(row);
  }

  saveDiscussion(discussion: GroupDiscussion): GroupDiscussion {
    try {
      const result = this.#database.prepare(`
        UPDATE group_discussions SET
          topic_id = ?, tenant_key = ?, chat_id = ?, question = ?, starter_principal_id = ?,
          state = ?, round = ?, turn_index = ?, next_provider = ?, round_order_json = ?,
          max_rounds = ?, version = ?, evaluated_turn_index = ?, start_message_id = ?,
          preferred_provider = ?, control_message_id = ?, active_turn_id = ?,
          summary_text = ?, updated_at = ?
        WHERE id = ?
      `).run(
        discussion.topicId,
        discussion.tenantKey,
        discussion.chatId,
        discussion.question,
        discussion.starterPrincipalId,
        discussion.state,
        discussion.round,
        discussion.turnIndex,
        discussion.nextProvider,
        JSON.stringify(discussion.roundOrder),
        discussion.maxRounds,
        discussion.version,
        discussion.evaluatedTurnIndex,
        discussion.startMessageId ?? null,
        discussion.preferredProvider ?? null,
        discussion.controlMessageId ?? null,
        discussion.activeTurnId ?? null,
        discussion.summaryText ?? null,
        discussion.updatedAt,
        discussion.id,
      );
      if (Number(result.changes) !== 1) throw new Error(`Discussion not found: ${discussion.id}`);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "UNIQUE constraint failed: group_discussions.start_message_id"
      ) {
        throw new Error("Discussion start message conflicts with another Discussion");
      }
      if (
        error instanceof Error
        && error.message === (
          "UNIQUE constraint failed: group_discussions.tenant_key, group_discussions.chat_id"
        )
      ) {
        throw new Error("This group already has an active Discussion");
      }
      throw error;
    }
    return this.discussion(discussion.id) as GroupDiscussion;
  }

  saveDiscussionCas(discussion: GroupDiscussion, expectedVersion: number): boolean {
    if (discussion.version !== expectedVersion + 1) {
      throw new Error("Discussion CAS must advance version by one");
    }
    const result = this.#database.prepare(`
      UPDATE group_discussions SET
        topic_id = ?, tenant_key = ?, chat_id = ?, question = ?, starter_principal_id = ?,
        state = ?, round = ?, turn_index = ?, next_provider = ?, round_order_json = ?,
        max_rounds = ?, version = ?, evaluated_turn_index = ?, start_message_id = ?,
        preferred_provider = ?, control_message_id = ?,
        active_turn_id = ?, summary_text = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(
      discussion.topicId,
      discussion.tenantKey,
      discussion.chatId,
      discussion.question,
      discussion.starterPrincipalId,
      discussion.state,
      discussion.round,
      discussion.turnIndex,
      discussion.nextProvider,
      JSON.stringify(discussion.roundOrder),
      discussion.maxRounds,
      discussion.version,
      discussion.evaluatedTurnIndex,
      discussion.startMessageId ?? null,
      discussion.preferredProvider ?? null,
      discussion.controlMessageId ?? null,
      discussion.activeTurnId ?? null,
      discussion.summaryText ?? null,
      discussion.updatedAt,
      discussion.id,
      expectedVersion,
    );
    return Number(result.changes) === 1;
  }

  activateTurn(
    discussionId: string,
    turnId: string,
    turnIndex: number,
    provider: ProviderName,
    now = new Date().toISOString(),
  ): GroupDiscussion {
    const result = this.#database.prepare(`
      UPDATE group_discussions SET
        active_turn_id = ?,
        preferred_provider = CASE WHEN preferred_provider = ? THEN NULL ELSE preferred_provider END,
        version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'active' AND turn_index = ?
    `).run(turnId, provider, now, discussionId, turnIndex);
    if (Number(result.changes) !== 1) {
      throw new Error(`Discussion turn can no longer be activated: ${discussionId}:${turnIndex}`);
    }
    return this.discussion(discussionId) as GroupDiscussion;
  }

  clearActiveTurn(
    discussionId: string,
    turnId: string,
    now = new Date().toISOString(),
  ): void {
    this.#database.prepare(`
      UPDATE group_discussions SET
        active_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND active_turn_id = ?
    `).run(now, discussionId, turnId);
  }

  recordControlMessage(discussionId: string, messageId: string, now = new Date().toISOString()): void {
    const current = this.discussion(discussionId);
    if (current === undefined) throw new Error(`Discussion not found: ${discussionId}`);
    if (current.controlMessageId === messageId) return;
    if (current.controlMessageId !== undefined) {
      throw new Error(`Discussion control message is already bound: ${discussionId}`);
    }
    const result = this.#database.prepare(`
      UPDATE group_discussions SET
        control_message_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND control_message_id IS NULL
    `).run(messageId, now, discussionId);
    if (Number(result.changes) !== 1) throw new Error(`Discussion not found: ${discussionId}`);
  }

  recordSteer(input: DiscussionSteerInput): { steer: DiscussionSteer; inserted: boolean } {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`
        SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
               preferred_provider, status, created_at, consumed_at
        FROM discussion_steers WHERE message_id = ?
      `).get(input.messageId) as SteerRow | undefined;
      if (existing !== undefined) {
        if (
          existing.discussion_id !== input.discussionId
          || existing.principal_id !== input.principalId
          || existing.text !== input.text
        ) {
          throw new Error(`Inconsistent Discussion steer receipt: ${input.messageId}`);
        }
        if (input.topicEventSeq !== undefined && input.topicEventSeq > 0) {
          if (existing.topic_event_seq === 0) {
            this.#database.prepare(`
              UPDATE discussion_steers SET topic_event_seq = ? WHERE id = ?
            `).run(input.topicEventSeq, existing.id);
          } else if (existing.topic_event_seq !== input.topicEventSeq) {
            throw new Error(`Discussion steer is already bound to another TopicEvent: ${existing.id}`);
          }
        }
        if (input.preferredProvider !== undefined && existing.preferred_provider === null) {
          this.#database.prepare(`
            UPDATE discussion_steers SET preferred_provider = ? WHERE id = ?
          `).run(input.preferredProvider, existing.id);
          this.#database.prepare(`
            UPDATE group_discussions SET preferred_provider = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND state IN ('active', 'paused')
          `).run(input.preferredProvider, createdAt, existing.discussion_id);
        }
        const steer = this.#steer(existing.id);
        this.#database.exec("COMMIT");
        return { steer: steer as DiscussionSteer, inserted: false };
      }
      const discussion = this.#database.prepare(`
        SELECT state FROM group_discussions WHERE id = ?
      `).get(input.discussionId) as { state: GroupDiscussion["state"] } | undefined;
      if (discussion === undefined) {
        throw new Error(`Discussion not found: ${input.discussionId}`);
      }
      if (
        discussion.state !== "active"
        && discussion.state !== "paused"
        && discussion.state !== "summarizing"
      ) {
        throw new Error(`Discussion no longer accepts steers: ${input.discussionId}`);
      }
      this.#database.prepare(`
        INSERT INTO discussion_steers (
          id, discussion_id, message_id, topic_event_seq, principal_id, text,
          preferred_provider, status, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      `).run(
        input.id,
        input.discussionId,
        input.messageId,
        input.topicEventSeq ?? 0,
        input.principalId,
        input.text,
        input.preferredProvider ?? null,
        createdAt,
      );
      if (input.preferredProvider !== undefined) {
        this.#database.prepare(`
          UPDATE group_discussions SET preferred_provider = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused')
        `).run(input.preferredProvider, createdAt, input.discussionId);
      }
      const steer = this.#steer(input.id);
      this.#database.exec("COMMIT");
      return { steer: steer as DiscussionSteer, inserted: true };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pendingSteers(discussionId: string): DiscussionSteer[] {
    const rows = this.#database.prepare(`
      SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
             preferred_provider, status, created_at, consumed_at
      FROM discussion_steers
      WHERE discussion_id = ? AND status = 'pending'
      ORDER BY created_at, id
    `).all(discussionId) as unknown as SteerRow[];
    return rows.map(mapSteer);
  }

  unpublishedSteers(): DiscussionSteer[] {
    const rows = this.#database.prepare(`
      SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
             preferred_provider, status, created_at, consumed_at
      FROM discussion_steers
      WHERE topic_event_seq = 0
      ORDER BY created_at, id
    `).all() as unknown as SteerRow[];
    return rows.map(mapSteer);
  }

  steerForMessage(messageId: string): DiscussionSteer | undefined {
    const row = this.#database.prepare(`
      SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
             preferred_provider, status, created_at, consumed_at
      FROM discussion_steers WHERE message_id = ?
    `).get(messageId) as SteerRow | undefined;
    return row === undefined ? undefined : mapSteer(row);
  }

  steersForTopicEvent(topicId: string, topicEventSeq: number): DiscussionSteer[] {
    const rows = this.#database.prepare(`
      SELECT s.id, s.discussion_id, s.message_id, s.topic_event_seq, s.principal_id, s.text,
             s.preferred_provider, s.status, s.created_at, s.consumed_at
      FROM group_discussions d
      JOIN discussion_steers s ON s.discussion_id = d.id
      WHERE d.topic_id = ? AND s.topic_event_seq = ?
      ORDER BY s.id
    `).all(topicId, topicEventSeq) as unknown as SteerRow[];
    return rows.map(mapSteer);
  }

  recordTerminalSteerTombstone(
    input: DiscussionSteerInput & { readonly topicEventSeq: number },
    consumedAt = new Date().toISOString(),
  ): DiscussionSteer {
    const createdAt = input.createdAt ?? consumedAt;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const discussion = this.#database.prepare(`
        SELECT state FROM group_discussions WHERE id = ?
      `).get(input.discussionId) as { state: GroupDiscussion["state"] } | undefined;
      if (discussion === undefined) throw new Error(`Discussion not found: ${input.discussionId}`);
      if (
        discussion.state === "active"
        || discussion.state === "paused"
        || discussion.state === "summarizing"
      ) {
        throw new Error(`Discussion is not terminal: ${input.discussionId}`);
      }
      const existing = this.#database.prepare(`
        SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
               preferred_provider, status, created_at, consumed_at
        FROM discussion_steers WHERE message_id = ?
      `).get(input.messageId) as SteerRow | undefined;
      if (existing !== undefined) {
        if (
          existing.discussion_id !== input.discussionId
          || existing.topic_event_seq !== input.topicEventSeq
          || existing.principal_id !== input.principalId
          || existing.text !== input.text
          || existing.status !== "consumed"
        ) {
          throw new Error(`Inconsistent Discussion steer tombstone: ${input.messageId}`);
        }
        this.#database.exec("COMMIT");
        return mapSteer(existing);
      }
      this.#database.prepare(`
        INSERT INTO discussion_steers (
          id, discussion_id, message_id, topic_event_seq, principal_id, text,
          preferred_provider, status, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?)
      `).run(
        input.id,
        input.discussionId,
        input.messageId,
        input.topicEventSeq,
        input.principalId,
        input.text,
        input.preferredProvider ?? null,
        createdAt,
        consumedAt,
      );
      const tombstone = this.#steer(input.id);
      this.#database.exec("COMMIT");
      return tombstone as DiscussionSteer;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  consumeSteers(discussionId: string, ids: readonly string[], consumedAt = new Date().toISOString()): void {
    const update = this.#database.prepare(`
      UPDATE discussion_steers SET status = 'consumed', consumed_at = ?
      WHERE discussion_id = ? AND id = ? AND status = 'pending'
    `);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) update.run(consumedAt, discussionId, id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  finalizeSummary(
    discussionId: string,
    summaryText: string,
    expectedSteerIds: readonly string[],
    completedAt = new Date().toISOString(),
  ): FinalizeDiscussionSummaryResult {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.discussion(discussionId);
      if (current === undefined) throw new Error(`Discussion not found: ${discussionId}`);
      if (current.state !== "summarizing") {
        this.#database.exec("COMMIT");
        return { status: "inactive" };
      }
      const pendingRows = this.#database.prepare(`
        SELECT id FROM discussion_steers
        WHERE discussion_id = ? AND status = 'pending'
        ORDER BY created_at, id
      `).all(discussionId) as unknown as Array<{ id: string }>;
      const pendingIds = pendingRows.map(({ id }) => id);
      if (
        pendingIds.length !== expectedSteerIds.length
        || pendingIds.some((id, index) => id !== expectedSteerIds[index])
      ) {
        this.#database.exec("COMMIT");
        return { status: "retry" };
      }
      const completed: GroupDiscussion = {
        ...current,
        state: "completed",
        summaryText,
        version: current.version + 1,
        updatedAt: completedAt,
      };
      const saved = this.#database.prepare(`
        UPDATE group_discussions SET
          state = 'completed', summary_text = ?, version = ?, updated_at = ?
        WHERE id = ? AND state = 'summarizing' AND version = ?
      `).run(summaryText, completed.version, completedAt, discussionId, current.version);
      if (Number(saved.changes) !== 1) {
        throw new Error(`Discussion summary completion conflicted: ${discussionId}`);
      }
      const consume = this.#database.prepare(`
        UPDATE discussion_steers SET status = 'consumed', consumed_at = ?
        WHERE discussion_id = ? AND id = ? AND status = 'pending'
      `);
      for (const id of expectedSteerIds) {
        const consumed = consume.run(completedAt, discussionId, id);
        if (Number(consumed.changes) !== 1) {
          throw new Error(`Discussion summary steer changed unexpectedly: ${id}`);
        }
      }
      this.#database.exec("COMMIT");
      return { status: "completed", discussion: completed };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimTurn(input: ClaimDiscussionTurnInput): boolean {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO discussion_turns (
        id, discussion_id, provider, round, turn_index, state,
        open_questions_json, steer_ids_json, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', '[]', ?, ?)
    `).run(
      input.id,
      input.discussionId,
      input.provider,
      input.round,
      input.turnIndex,
      JSON.stringify(input.steerIds ?? []),
      input.startedAt ?? new Date().toISOString(),
    );
    return Number(result.changes) === 1;
  }

  markTurnRunning(id: string, startedAt = new Date().toISOString()): void {
    const result = this.#database.prepare(`
      UPDATE discussion_turns SET state = 'running', started_at = ?
      WHERE id = ? AND state = 'queued'
    `).run(startedAt, id);
    if (Number(result.changes) !== 1) throw new Error(`Queued Discussion turn not found: ${id}`);
  }

  restartTurn(
    id: string,
    provider: ProviderName,
    round: number,
    steerIds: readonly string[] = [],
    startedAt = new Date().toISOString(),
  ): void {
    const result = this.#database.prepare(`
      UPDATE discussion_turns SET
        provider = ?, round = ?, state = 'running', external_session_id = NULL,
        text = NULL, continue_discussion = NULL, open_questions_json = '[]',
        steer_ids_json = ?, started_at = ?, completed_at = NULL
      WHERE id = ? AND (
        state IN ('queued', 'cancelled')
        OR (
          state = 'failed'
          AND EXISTS (
            SELECT 1 FROM group_discussions AS current
            WHERE current.id = discussion_turns.discussion_id
              AND current.state = 'active'
              AND current.active_turn_id = discussion_turns.id
              AND current.turn_index = discussion_turns.turn_index
          )
        )
      )
    `).run(provider, round, JSON.stringify(steerIds), startedAt, id);
    if (Number(result.changes) !== 1) {
      throw new Error(`Restartable Discussion turn not found: ${id}`);
    }
  }

  completeTurn(input: CompleteDiscussionTurnInput): void {
    const result = this.#database.prepare(`
      UPDATE discussion_turns SET
        state = 'completed', external_session_id = ?, text = ?,
        continue_discussion = ?, open_questions_json = ?, completed_at = ?
      WHERE id = ? AND state = 'running'
    `).run(
      input.externalSessionId,
      input.text,
      input.continueDiscussion ? 1 : 0,
      JSON.stringify(input.openQuestions),
      input.completedAt ?? new Date().toISOString(),
      input.id,
    );
    if (Number(result.changes) !== 1) throw new Error(`Running Discussion turn not found: ${input.id}`);
  }

  failTurn(id: string, state: "cancelled" | "failed", completedAt = new Date().toISOString()): void {
    const result = this.#database.prepare(`
      UPDATE discussion_turns SET state = ?, completed_at = ?
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(state, completedAt, id);
    if (Number(result.changes) !== 1) throw new Error(`Active Discussion turn not found: ${id}`);
  }

  turn(id: string): DiscussionTurn | undefined {
    const row = this.#database.prepare(`${TURN_SELECT} WHERE id = ?`).get(id) as TurnRow | undefined;
    return row === undefined ? undefined : mapTurn(row);
  }

  turnForIndex(discussionId: string, turnIndex: number): DiscussionTurn | undefined {
    const row = this.#database.prepare(`
      ${TURN_SELECT} WHERE discussion_id = ? AND turn_index = ?
    `).get(discussionId, turnIndex) as TurnRow | undefined;
    return row === undefined ? undefined : mapTurn(row);
  }

  turns(discussionId: string): DiscussionTurn[] {
    const rows = this.#database.prepare(`
      ${TURN_SELECT} WHERE discussion_id = ? ORDER BY turn_index, id
    `).all(discussionId) as unknown as TurnRow[];
    return rows.map(mapTurn);
  }

  roundVotes(discussionId: string, round: number): boolean[] {
    const rows = this.#database.prepare(`
      SELECT continue_discussion FROM discussion_turns
      WHERE discussion_id = ? AND round = ? AND state = 'completed'
        AND continue_discussion IS NOT NULL
      ORDER BY turn_index
    `).all(discussionId, round) as unknown as Array<{ continue_discussion: number }>;
    return rows.map((row) => Number(row.continue_discussion) === 1);
  }

  recoverInterrupted(): { discussionIds: string[]; turnIds: string[] } {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`
        SELECT id, discussion_id FROM discussion_turns
        WHERE state = 'running' ORDER BY discussion_id, turn_index, id
      `).all() as unknown as Array<{ id: string; discussion_id: string }>;
      if (rows.length > 0) {
        const requeue = this.#database.prepare(`
          UPDATE discussion_turns SET state = 'queued' WHERE id = ? AND state = 'running'
        `);
        const clear = this.#database.prepare(`
          UPDATE group_discussions SET active_turn_id = NULL WHERE id = ? AND active_turn_id = ?
        `);
        for (const row of rows) {
          requeue.run(row.id);
          clear.run(row.discussion_id, row.id);
        }
      }
      this.#database.exec("COMMIT");
      return {
        discussionIds: [...new Set(rows.map((row) => row.discussion_id))],
        turnIds: rows.map((row) => row.id),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recoverableDiscussions(): GroupDiscussion[] {
    const rows = this.#database.prepare(`
      ${DISCUSSION_SELECT}
      ORDER BY updated_at, id
    `).all() as unknown as DiscussionRow[];
    return rows.map(mapDiscussion);
  }

  #steer(id: string): DiscussionSteer | undefined {
    const row = this.#database.prepare(`
      SELECT id, discussion_id, message_id, topic_event_seq, principal_id, text,
             preferred_provider, status, created_at, consumed_at
      FROM discussion_steers WHERE id = ?
    `).get(id) as SteerRow | undefined;
    return row === undefined ? undefined : mapSteer(row);
  }
}

const DISCUSSION_SELECT = `
  SELECT id, topic_id, tenant_key, chat_id, question, starter_principal_id,
         state, round, turn_index, next_provider, round_order_json, max_rounds, version,
         evaluated_turn_index, start_message_id, preferred_provider, control_message_id,
         active_turn_id, summary_text, created_at, updated_at
  FROM group_discussions
`;

const TURN_SELECT = `
  SELECT id, discussion_id, provider, round, turn_index, state,
         external_session_id, text, continue_discussion, open_questions_json, steer_ids_json,
         started_at, completed_at
  FROM discussion_turns
`;

function mapDiscussion(row: DiscussionRow): GroupDiscussion {
  return {
    id: row.id,
    topicId: row.topic_id,
    tenantKey: row.tenant_key,
    chatId: row.chat_id,
    question: row.question,
    starterPrincipalId: row.starter_principal_id,
    state: row.state,
    round: Number(row.round),
    turnIndex: Number(row.turn_index),
    nextProvider: row.next_provider,
    roundOrder: parseProviderArray(row.round_order_json),
    maxRounds: Number(row.max_rounds),
    version: Number(row.version),
    evaluatedTurnIndex: Number(row.evaluated_turn_index),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.start_message_id === null ? {} : { startMessageId: row.start_message_id }),
    ...(row.preferred_provider === null ? {} : { preferredProvider: row.preferred_provider }),
    ...(row.control_message_id === null ? {} : { controlMessageId: row.control_message_id }),
    ...(row.active_turn_id === null ? {} : { activeTurnId: row.active_turn_id }),
    ...(row.summary_text === null ? {} : { summaryText: row.summary_text }),
  };
}

function mapSteer(row: SteerRow): DiscussionSteer {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    messageId: row.message_id,
    topicEventSeq: Number(row.topic_event_seq),
    principalId: row.principal_id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    ...(row.preferred_provider === null ? {} : { preferredProvider: row.preferred_provider }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  };
}

function mapTurn(row: TurnRow): DiscussionTurn {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    provider: row.provider,
    round: Number(row.round),
    turnIndex: Number(row.turn_index),
    state: row.state,
    openQuestions: parseStringArray(row.open_questions_json),
    steerIds: parseStringArray(row.steer_ids_json),
    ...(row.external_session_id === null ? {} : { externalSessionId: row.external_session_id }),
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.continue_discussion === null
      ? {}
      : { continueDiscussion: Number(row.continue_discussion) === 1 }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function parseStringArray(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored Discussion open questions are invalid");
  }
  return value;
}

function parseProviderArray(json: string): ProviderName[] {
  const values = parseStringArray(json);
  if (
    values.length !== 3
    || new Set(values).size !== 3
    || values.some((provider) => provider !== "claude" && provider !== "codex" && provider !== "copilot")
  ) {
    throw new Error("Stored Discussion round order is invalid");
  }
  return values as ProviderName[];
}

function sameDiscussionStart(existing: GroupDiscussion, candidate: GroupDiscussion): boolean {
  return existing.startMessageId === candidate.startMessageId
    && existing.tenantKey === candidate.tenantKey
    && existing.chatId === candidate.chatId
    && existing.topicId === candidate.topicId
    && existing.question === candidate.question
    && existing.starterPrincipalId === candidate.starterPrincipalId;
}
