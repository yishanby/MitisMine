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
    return new EventStore(database);
  }

  close(): void {
    this.#database.close();
  }

  append(input: AppendEventInput): TopicEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
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

  recordFeishuEvent(appRole: string, eventId: string): boolean {
    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO processed_feishu_events (app_role, event_id, processed_at)
        VALUES (?, ?, ?)
      `)
      .run(appRole, eventId, new Date().toISOString());
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
