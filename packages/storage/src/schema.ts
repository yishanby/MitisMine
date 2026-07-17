export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topic_members (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (topic_id, principal_id)
);

CREATE TABLE IF NOT EXISTS user_topic_cursors (
  tenant_key TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_key, principal_id)
);

CREATE TABLE IF NOT EXISTS topic_events (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_principal_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, seq)
);

CREATE TABLE IF NOT EXISTS topic_event_effects (
  effect_key TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  FOREIGN KEY (topic_id, seq) REFERENCES topic_events(topic_id, seq) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS processed_feishu_events (
  app_role TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'processing', 'completed')),
  PRIMARY KEY (app_role, event_id)
);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  coordinator_provider TEXT NOT NULL,
  unresolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  role TEXT NOT NULL,
  external_session_id TEXT,
  context_watermark INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  UNIQUE (topic_id, provider, role)
);

CREATE TABLE IF NOT EXISTS direct_sessions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  title TEXT NOT NULL COLLATE NOCASE,
  external_session_id TEXT,
  context_watermark INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'running', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (topic_id, provider, title)
);

CREATE TABLE IF NOT EXISTS direct_session_effects (
  effect_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS direct_session_cursors (
  tenant_key TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_key, principal_id, topic_id, provider)
);

CREATE INDEX IF NOT EXISTS direct_sessions_topic_provider_updated_idx
  ON direct_sessions (topic_id, provider, updated_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  author_session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  quote TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  tool_trace_id TEXT
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  agent_vote TEXT,
  PRIMARY KEY (claim_id, evidence_id, relation)
);

CREATE TABLE IF NOT EXISTS critiques (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  target_claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  reviewer_session_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  app_role TEXT NOT NULL,
  receive_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS worker_leases (
  task_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS worker_lease_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_checkpoints (
  run_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orchestration_records_run_idx
  ON orchestration_records (run_id, id);
`;
