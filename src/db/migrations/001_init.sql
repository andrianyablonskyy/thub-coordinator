-- Schema mirrors README.md §9 (SQLite ER diagram).

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ci', 'cli')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('hw', 'sw')),
  status TEXT NOT NULL DEFAULT 'REGISTERED',
  busy_source TEXT CHECK (busy_source IN ('ci', 'cli', 'local')),
  busy_reason TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  host_info TEXT,
  token_hash TEXT UNIQUE,
  -- Unused: resources self-register via the shared clientJoinKey
  -- (registry.registerAuto) rather than an admin-issued enrollment token.
  -- Left in place because SQLite can't drop a UNIQUE column without a
  -- full table rebuild, which isn't worth it for two dead columns.
  enrollment_hash TEXT UNIQUE,
  enrollment_expires_at TEXT,
  last_heartbeat_at TEXT,
  last_job_finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  resource_id TEXT REFERENCES resources(id),
  source TEXT NOT NULL CHECK (source IN ('ci', 'cli')),
  state TEXT NOT NULL,
  spec TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  attempt INTEGER NOT NULL DEFAULT 1,
  exit_code INTEGER,
  summary TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  deadline_at TEXT
);

CREATE TABLE job_logs (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  stream TEXT NOT NULL,
  line TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  content_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('job', 'resource', 'agent')),
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);

-- Dashboard login (§10): separate from API tokens.
CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO counters (name, value) VALUES ('job_id', 0);

CREATE INDEX idx_jobs_scheduler ON jobs(state, priority DESC, created_at);
CREATE INDEX idx_resources_status_type ON resources(status, type);
CREATE INDEX idx_resources_heartbeat ON resources(last_heartbeat_at);
CREATE INDEX idx_jobs_agent ON jobs(agent_id);
CREATE INDEX idx_artifacts_job ON artifacts(job_id);
CREATE INDEX idx_events_entity ON events(entity, entity_id);
