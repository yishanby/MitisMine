import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Topic, TopicMember } from "../../domain/src/model.js";
import { SCHEMA_SQL } from "./schema.js";

export interface AppendEventInput {
  readonly topicId: string;
  readonly type: string;
  readonly actorPrincipalId?: string;
  readonly payload: unknown;
  readonly createdAt?: string;
  readonly idempotencyKey?: string;
}

export interface TopicEvent {
  readonly topicId: string;
  readonly seq: number;
  readonly type: string;
  readonly actorPrincipalId?: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface TopicRow {
  id: string;
  tenant_key: string;
  title: string;
  owner_principal_id: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  last_event_seq: number;
}

interface EventRow {
  topic_id: string;
  seq: number;
  type: string;
  actor_principal_id: string | null;
  payload_json: string;
  created_at: string;
}

export interface StoredAgentSession {
  readonly id: string;
  readonly topicId: string;
  readonly provider: string;
  readonly role: string;
  readonly externalSessionId?: string;
  readonly contextWatermark: number;
  readonly status: string;
}

interface AgentSessionRow {
  id: string;
  topic_id: string;
  provider: string;
  role: string;
  external_session_id: string | null;
  context_watermark: number;
  status: string;
}

export type DirectSessionStatus = "active" | "running" | "archived";

export interface StoredDirectSession {
  readonly id: string;
  readonly topicId: string;
  readonly provider: string;
  readonly title: string;
  readonly externalSessionId?: string;
  readonly contextWatermark: number;
  readonly status: DirectSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDirectSessionInput {
  readonly id: string;
  readonly topicId: string;
  readonly provider: string;
  readonly title: string;
  readonly now?: string;
  readonly idempotencyKey?: string;
}

export interface UpdateDirectSessionInput {
  readonly externalSessionId?: string;
  readonly contextWatermark?: number;
  readonly status?: DirectSessionStatus;
  readonly now?: string;
}

interface DirectSessionRow {
  id: string;
  topic_id: string;
  provider: string;
  title: string;
  external_session_id: string | null;
  context_watermark: number;
  status: DirectSessionStatus;
  created_at: string;
  updated_at: string;
}

export class EventStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): EventStore {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    const inboxColumns = database
      .prepare("PRAGMA table_info(processed_feishu_events)")
      .all() as unknown as Array<{ name: string }>;
    if (!inboxColumns.some((column) => column.name === "status")) {
      database.exec("ALTER TABLE processed_feishu_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
    }
    database.prepare("UPDATE processed_feishu_events SET status = 'pending' WHERE status = 'processing'").run();
    const migratedAt = new Date().toISOString();
    database.prepare(`
      INSERT OR IGNORE INTO direct_sessions (
        id, topic_id, provider, title, external_session_id,
        context_watermark, status, created_at, updated_at
      )
      SELECT id, topic_id, provider, 'main', external_session_id,
             context_watermark,
             CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END,
             ?, ?
      FROM agent_sessions
      WHERE role = 'direct'
    `).run(migratedAt, migratedAt);
    database.prepare(`
      UPDATE direct_sessions SET status = 'active', updated_at = ? WHERE status = 'running'
    `).run(migratedAt);
    return new EventStore(database);
  }

  close(): void {
    this.#database.close();
  }

  eventForEffect(idempotencyKey: string): TopicEvent | undefined {
    const row = this.#database.prepare(`
      SELECT e.topic_id, e.seq, e.type, e.actor_principal_id, e.payload_json, e.created_at
      FROM topic_event_effects i
      JOIN topic_events e ON e.topic_id = i.topic_id AND e.seq = i.seq
      WHERE i.effect_key = ?
    `).get(idempotencyKey) as EventRow | undefined;
    return row === undefined ? undefined : mapEvent(row);
  }

  append(input: AppendEventInput): TopicEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey !== undefined) {
        const existing = this.#database
          .prepare(`
            SELECT e.topic_id, e.seq, e.type, e.actor_principal_id, e.payload_json, e.created_at
            FROM topic_event_effects i
            JOIN topic_events e ON e.topic_id = i.topic_id AND e.seq = i.seq
            WHERE i.effect_key = ?
          `)
          .get(input.idempotencyKey) as EventRow | undefined;
        if (existing !== undefined) {
          this.#database.exec("COMMIT");
          return mapEvent(existing);
        }
      }
      const seqRow = this.#database
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM topic_events WHERE topic_id = ?")
        .get(input.topicId) as { seq: number };
      const seq = Number(seqRow.seq);

      if (input.type === "topic.created") {
        const topic = this.#topicFromCreatedPayload(input.payload, input.topicId);
        this.#database
          .prepare(`
            INSERT INTO topics (
              id, tenant_key, title, owner_principal_id, status,
              created_at, updated_at, last_event_seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            topic.id,
            topic.tenantKey,
            topic.title,
            topic.ownerPrincipalId,
            topic.status,
            topic.createdAt,
            topic.updatedAt,
            seq,
          );
      } else {
        const result = this.#database
          .prepare("UPDATE topics SET last_event_seq = ?, updated_at = ? WHERE id = ?")
          .run(seq, createdAt, input.topicId);
        if (Number(result.changes) !== 1) {
          throw new Error(`Topic not found: ${input.topicId}`);
        }
        if (input.type === "topic.archived") {
          const topic = this.#topicFromPayload(input.payload, input.topicId);
          this.#database
            .prepare("UPDATE topics SET status = ?, updated_at = ? WHERE id = ?")
            .run(topic.status, topic.updatedAt, input.topicId);
        }
        if (input.type === "topic.shared") {
          const member = this.#memberFromPayload(input.payload);
          this.#database
            .prepare(`
              INSERT INTO topic_members (topic_id, principal_id, role)
              VALUES (?, ?, ?)
              ON CONFLICT (topic_id, principal_id) DO UPDATE SET role = excluded.role
            `)
            .run(input.topicId, member.principalId, member.role);
        }
      }

      this.#database
        .prepare(`
          INSERT INTO topic_events (
            topic_id, seq, type, actor_principal_id, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.topicId,
          seq,
          input.type,
          input.actorPrincipalId ?? null,
          JSON.stringify(input.payload),
          createdAt,
        );
      if (input.idempotencyKey !== undefined) {
        this.#database
          .prepare("INSERT INTO topic_event_effects (effect_key, topic_id, seq) VALUES (?, ?, ?)")
          .run(input.idempotencyKey, input.topicId, seq);
      }
      this.#database.exec("COMMIT");
      const event: TopicEvent = {
        topicId: input.topicId,
        seq,
        type: input.type,
        payload: input.payload,
        createdAt,
        ...(input.actorPrincipalId === undefined
          ? {}
          : { actorPrincipalId: input.actorPrincipalId }),
      };
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  events(topicId: string): TopicEvent[] {
    const rows = this.#database
      .prepare(`
        SELECT topic_id, seq, type, actor_principal_id, payload_json, created_at
        FROM topic_events WHERE topic_id = ? ORDER BY seq ASC
      `)
      .all(topicId) as unknown as EventRow[];
    return rows.map((row) => ({
      topicId: row.topic_id,
      seq: Number(row.seq),
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
      ...(row.actor_principal_id === null
        ? {}
        : { actorPrincipalId: row.actor_principal_id }),
    }));
  }

  eventsByType(type: string): TopicEvent[] {
    const rows = this.#database
      .prepare(`
        SELECT topic_id, seq, type, actor_principal_id, payload_json, created_at
        FROM topic_events WHERE type = ? ORDER BY topic_id, seq
      `)
      .all(type) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  topic(topicId: string): Topic | undefined {
    const row = this.#database
      .prepare(`
        SELECT id, tenant_key, title, owner_principal_id, status,
               created_at, updated_at, last_event_seq
        FROM topics WHERE id = ?
      `)
      .get(topicId) as TopicRow | undefined;
    return row === undefined ? undefined : this.#mapTopic(row);
  }

  listTopics(tenantKey: string, principalId: string): Topic[] {
    const rows = this.#database
      .prepare(`
        SELECT DISTINCT t.id, t.tenant_key, t.title, t.owner_principal_id,
               t.status, t.created_at, t.updated_at, t.last_event_seq
        FROM topics t
        LEFT JOIN topic_members m ON m.topic_id = t.id
        WHERE t.tenant_key = ? AND (t.owner_principal_id = ? OR m.principal_id = ?)
        ORDER BY t.updated_at DESC, t.id DESC
      `)
      .all(tenantKey, principalId, principalId) as unknown as TopicRow[];
    return rows.map((row) => this.#mapTopic(row));
  }

  members(topicId: string): TopicMember[] {
    return this.#database
      .prepare("SELECT principal_id, role FROM topic_members WHERE topic_id = ? ORDER BY principal_id")
      .all(topicId)
      .map((row) => {
        const member = row as { principal_id: string; role: "editor" | "viewer" };
        return { principalId: member.principal_id, role: member.role };
      });
  }

  setCurrentTopic(tenantKey: string, principalId: string, topicId: string): void {
    this.#database
      .prepare(`
        INSERT INTO user_topic_cursors (tenant_key, principal_id, topic_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_key, principal_id) DO UPDATE SET
          topic_id = excluded.topic_id,
          updated_at = excluded.updated_at
      `)
      .run(tenantKey, principalId, topicId, new Date().toISOString());
  }

  currentTopic(tenantKey: string, principalId: string): string | undefined {
    const row = this.#database
      .prepare(`
        SELECT topic_id FROM user_topic_cursors
        WHERE tenant_key = ? AND principal_id = ?
      `)
      .get(tenantKey, principalId) as { topic_id: string } | undefined;
    return row?.topic_id;
  }

  claimFeishuEvent(appRole: string, eventId: string): "claimed" | "processing" | "completed" {
    const result = this.#database
      .prepare(`
        INSERT INTO processed_feishu_events (app_role, event_id, processed_at, status)
        VALUES (?, ?, ?, 'processing')
        ON CONFLICT (app_role, event_id) DO UPDATE SET
          processed_at = excluded.processed_at,
          status = 'processing'
        WHERE processed_feishu_events.status = 'pending'
      `)
      .run(appRole, eventId, new Date().toISOString());
    if (Number(result.changes) === 1) return "claimed";
    const row = this.#database
      .prepare("SELECT status FROM processed_feishu_events WHERE app_role = ? AND event_id = ?")
      .get(appRole, eventId) as { status: "processing" | "completed" };
    return row.status;
  }

  recordFeishuEvent(appRole: string, eventId: string): boolean {
    return this.claimFeishuEvent(appRole, eventId) === "claimed";
  }

  completeFeishuEvent(appRole: string, eventId: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE processed_feishu_events SET status = 'completed', processed_at = ?
        WHERE app_role = ? AND event_id = ? AND status = 'processing'
      `)
      .run(new Date().toISOString(), appRole, eventId);
    return Number(result.changes) === 1;
  }

  releaseFeishuEventClaim(appRole: string, eventId: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE processed_feishu_events SET status = 'pending', processed_at = ?
        WHERE app_role = ? AND event_id = ? AND status = 'processing'
      `)
      .run(new Date().toISOString(), appRole, eventId);
    return Number(result.changes) === 1;
  }

  agentSession(topicId: string, provider: string, role: string): StoredAgentSession | undefined {
    const row = this.#database
      .prepare(`
        SELECT id, topic_id, provider, role, external_session_id,
               context_watermark, status
        FROM agent_sessions WHERE topic_id = ? AND provider = ? AND role = ?
      `)
      .get(topicId, provider, role) as AgentSessionRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          topicId: row.topic_id,
          provider: row.provider,
          role: row.role,
          contextWatermark: Number(row.context_watermark),
          status: row.status,
          ...(row.external_session_id === null
            ? {}
            : { externalSessionId: row.external_session_id }),
        };
  }

  upsertAgentSession(session: StoredAgentSession): void {
    this.#database
      .prepare(`
        INSERT INTO agent_sessions (
          id, topic_id, provider, role, external_session_id,
          context_watermark, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (topic_id, provider, role) DO UPDATE SET
          external_session_id = excluded.external_session_id,
          context_watermark = excluded.context_watermark,
          status = excluded.status
      `)
      .run(
        session.id,
        session.topicId,
        session.provider,
        session.role,
        session.externalSessionId ?? null,
        session.contextWatermark,
        session.status,
      );
  }

  createDirectSession(input: CreateDirectSessionInput): StoredDirectSession {
    const title = normalizeDirectSessionTitle(input.title);
    const now = input.now ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey !== undefined) {
        const prior = this.#database.prepare(`
          SELECT session_id FROM direct_session_effects WHERE effect_key = ?
        `).get(input.idempotencyKey) as { session_id: string } | undefined;
        if (prior !== undefined) {
          const existing = this.directSession(prior.session_id);
          if (existing === undefined) throw new Error("Idempotent direct Session effect is missing");
          this.#database.exec("COMMIT");
          return existing;
        }
      }
      this.#database.prepare(`
        INSERT INTO direct_sessions (
          id, topic_id, provider, title, external_session_id,
          context_watermark, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 0, 'active', ?, ?)
      `).run(input.id, input.topicId, input.provider, title, now, now);
      if (input.idempotencyKey !== undefined) {
        this.#database.prepare(`
          INSERT INTO direct_session_effects (effect_key, session_id) VALUES (?, ?)
        `).run(input.idempotencyKey, input.id);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (isSqliteConstraint(error)) {
        throw new Error(`Direct Session '${title}' already exists for this Topic and provider`);
      }
      throw error;
    }
    const session = this.directSession(input.id);
    if (session === undefined) throw new Error("Created direct Session is missing");
    return session;
  }

  directSession(id: string): StoredDirectSession | undefined {
    const row = this.#database.prepare(`
      SELECT id, topic_id, provider, title, external_session_id,
             context_watermark, status, created_at, updated_at
      FROM direct_sessions WHERE id = ?
    `).get(id) as DirectSessionRow | undefined;
    return row === undefined ? undefined : mapDirectSession(row);
  }

  directSessionEffect(idempotencyKey: string): StoredDirectSession | undefined {
    const row = this.#database.prepare(`
      SELECT s.id, s.topic_id, s.provider, s.title, s.external_session_id,
             s.context_watermark, s.status, s.created_at, s.updated_at
      FROM direct_session_effects e
      JOIN direct_sessions s ON s.id = e.session_id
      WHERE e.effect_key = ?
    `).get(idempotencyKey) as DirectSessionRow | undefined;
    return row === undefined ? undefined : mapDirectSession(row);
  }

  listDirectSessions(topicId: string, provider: string): StoredDirectSession[] {
    const rows = this.#database.prepare(`
      SELECT id, topic_id, provider, title, external_session_id,
             context_watermark, status, created_at, updated_at
      FROM direct_sessions
      WHERE topic_id = ? AND provider = ?
      ORDER BY updated_at DESC, id DESC
    `).all(topicId, provider) as unknown as DirectSessionRow[];
    return rows.map(mapDirectSession);
  }

  resolveDirectSession(
    topicId: string,
    provider: string,
    selector: string,
  ): StoredDirectSession | undefined {
    const normalized = normalizeDirectSessionTitle(selector);
    const sessions = this.listDirectSessions(topicId, provider)
      .filter((session) => session.status !== "archived");
    const titleMatches = sessions.filter(
      (session) => session.title.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    );
    if (titleMatches.length === 1) return titleMatches[0];
    const idMatches = sessions.filter(
      (session) => session.id.toLocaleLowerCase().startsWith(normalized.toLocaleLowerCase()),
    );
    if (idMatches.length > 1) throw new Error("Direct Session selector is ambiguous");
    return idMatches[0];
  }

  renameDirectSession(id: string, title: string, now = new Date().toISOString()): StoredDirectSession {
    const normalized = normalizeDirectSessionTitle(title);
    try {
      const result = this.#database.prepare(`
        UPDATE direct_sessions SET title = ?, updated_at = ? WHERE id = ? AND status != 'archived'
      `).run(normalized, now, id);
      if (Number(result.changes) !== 1) throw new Error(`Active direct Session not found: ${id}`);
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new Error(`Direct Session '${normalized}' already exists for this Topic and provider`);
      }
      throw error;
    }
    return this.directSession(id) as StoredDirectSession;
  }

  updateDirectSession(id: string, input: UpdateDirectSessionInput): StoredDirectSession {
    const current = this.directSession(id);
    if (current === undefined) throw new Error(`Direct Session not found: ${id}`);
    const now = input.now ?? new Date().toISOString();
    this.#database.prepare(`
      UPDATE direct_sessions SET
        external_session_id = ?, context_watermark = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.externalSessionId ?? current.externalSessionId ?? null,
      input.contextWatermark ?? current.contextWatermark,
      input.status ?? current.status,
      now,
      id,
    );
    return this.directSession(id) as StoredDirectSession;
  }

  archiveDirectSession(
    id: string,
    now = new Date().toISOString(),
    idempotencyKey?: string,
  ): StoredDirectSession {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (idempotencyKey !== undefined) {
        const prior = this.directSessionEffect(idempotencyKey);
        if (prior !== undefined) {
          this.#database.exec("COMMIT");
          return prior;
        }
      }
      const result = this.#database.prepare(`
        UPDATE direct_sessions SET status = 'archived', updated_at = ?
        WHERE id = ? AND status != 'archived'
      `).run(now, id);
      if (Number(result.changes) !== 1) throw new Error(`Active direct Session not found: ${id}`);
      this.#database.prepare("DELETE FROM direct_session_cursors WHERE session_id = ?").run(id);
      if (idempotencyKey !== undefined) {
        this.#database.prepare(`
          INSERT INTO direct_session_effects (effect_key, session_id) VALUES (?, ?)
        `).run(idempotencyKey, id);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.directSession(id) as StoredDirectSession;
  }

  setCurrentDirectSession(
    tenantKey: string,
    principalId: string,
    topicId: string,
    provider: string,
    sessionId: string,
  ): void {
    const session = this.directSession(sessionId);
    if (session === undefined || session.topicId !== topicId || session.provider !== provider) {
      throw new Error("Direct Session does not belong to this Topic and provider");
    }
    if (session.status === "archived") throw new Error("Direct Session is archived");
    this.#database.prepare(`
      INSERT INTO direct_session_cursors (
        tenant_key, principal_id, topic_id, provider, session_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_key, principal_id, topic_id, provider) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(tenantKey, principalId, topicId, provider, sessionId, new Date().toISOString());
  }

  currentDirectSession(
    tenantKey: string,
    principalId: string,
    topicId: string,
    provider: string,
  ): StoredDirectSession | undefined {
    const row = this.#database.prepare(`
      SELECT s.id, s.topic_id, s.provider, s.title, s.external_session_id,
             s.context_watermark, s.status, s.created_at, s.updated_at
      FROM direct_session_cursors c
      JOIN direct_sessions s ON s.id = c.session_id
      WHERE c.tenant_key = ? AND c.principal_id = ?
        AND c.topic_id = ? AND c.provider = ? AND s.status != 'archived'
    `).get(tenantKey, principalId, topicId, provider) as DirectSessionRow | undefined;
    return row === undefined ? undefined : mapDirectSession(row);
  }

  #topicFromCreatedPayload(payload: unknown, topicId: string): Topic {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("topic" in payload) ||
      typeof payload.topic !== "object" ||
      payload.topic === null
    ) {
      throw new Error("topic.created payload is invalid");
    }
    const topic = payload.topic as Topic;
    if (topic.id !== topicId) {
      throw new Error("topic.created ID does not match event Topic");
    }
    return topic;
  }

  #topicFromPayload(payload: unknown, topicId: string): Topic {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("topic" in payload) ||
      typeof payload.topic !== "object" ||
      payload.topic === null
    ) {
      throw new Error("Topic event payload is invalid");
    }
    const topic = payload.topic as Topic;
    if (topic.id !== topicId) throw new Error("Topic event ID does not match event Topic");
    return topic;
  }

  #memberFromPayload(payload: unknown): TopicMember {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("member" in payload) ||
      typeof payload.member !== "object" ||
      payload.member === null
    ) {
      throw new Error("topic.shared payload is invalid");
    }
    const member = payload.member as TopicMember;
    if (!member.principalId || (member.role !== "editor" && member.role !== "viewer")) {
      throw new Error("topic.shared member is invalid");
    }
    return member;
  }

  #mapTopic(row: TopicRow): Topic {
    return {
      id: row.id,
      tenantKey: row.tenant_key,
      title: row.title,
      ownerPrincipalId: row.owner_principal_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEventSeq: Number(row.last_event_seq),
    };
  }
}

function mapEvent(row: EventRow): TopicEvent {
  return {
    topicId: row.topic_id,
    seq: Number(row.seq),
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    ...(row.actor_principal_id === null ? {} : { actorPrincipalId: row.actor_principal_id }),
  };
}

function mapDirectSession(row: DirectSessionRow): StoredDirectSession {
  return {
    id: row.id,
    topicId: row.topic_id,
    provider: row.provider,
    title: row.title,
    contextWatermark: Number(row.context_watermark),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.external_session_id === null ? {} : { externalSessionId: row.external_session_id }),
  };
}

function normalizeDirectSessionTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Direct Session title is required");
  if (normalized.length > 120) throw new Error("Direct Session title must not exceed 120 characters");
  return normalized;
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}
