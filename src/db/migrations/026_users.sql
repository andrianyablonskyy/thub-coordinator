-- User management (README §10.3): one account table for everyone. Roles:
--   user        submits jobs with the Agent and reads its results; no dashboard
--   maintainer  user + the dashboard, without its security features
--   admin       everything
-- Each user may hold one access key: an `agents` row linked by user_id
-- (jobs already reference agents, so a user's job history stays attached
-- across key rotations). CI tokens stay agents rows without a user.
--
-- admin_users becomes users: SQLite can't change its role CHECK in place.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  -- NULL: no dashboard sign-in (role user, or a converted agent token).
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'maintainer', 'admin')),
  first_name TEXT,
  last_name TEXT,
  avatar_path TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
  session_timeout_min INTEGER NOT NULL DEFAULT 60,
  list_prefs TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  blocked_at TEXT,
  created_at TEXT NOT NULL
);

-- Dashboard accounts: admin stays admin; viewer becomes maintainer.
INSERT INTO users (id, username, email, password_hash, role, first_name, last_name, avatar_path, timezone, theme,
                   session_timeout_min, list_prefs, created_at)
  SELECT id, username, '', password_hash, CASE role WHEN 'viewer' THEN 'maintainer' ELSE role END,
         first_name, last_name, avatar_path, timezone, theme, session_timeout_min, list_prefs, created_at
  FROM admin_users;

DROP TABLE admin_users;

-- Every developer (cli) agent token becomes a user that owns it, so each
-- existing key keeps working. Its name becomes the username — suffixed
-- where that's taken (a dashboard account, an earlier token of the same
-- name). A revoked token becomes a blocked user, kept for its job history.
INSERT INTO users (id, username, email, password_hash, role, blocked_at, created_at)
  SELECT 'usr_' || substr(a.id, 5),
         a.name || CASE
           WHEN EXISTS (SELECT 1 FROM users u WHERE u.username = a.name)
             OR EXISTS (SELECT 1 FROM agents b WHERE b.kind = 'cli' AND b.name = a.name AND (b.created_at < a.created_at OR (b.created_at = a.created_at AND b.id < a.id)))
           THEN '-' || substr(a.id, 5, 6) ELSE '' END,
         '', NULL, 'user', a.revoked_at, a.created_at
  FROM agents a
  WHERE a.kind = 'cli';

ALTER TABLE agents ADD COLUMN user_id TEXT REFERENCES users(id);
-- The last characters of the key, to recognize it by (keys are stored hashed).
ALTER TABLE agents ADD COLUMN token_hint TEXT;
ALTER TABLE agents ADD COLUMN token_created_at TEXT;
UPDATE agents SET user_id = 'usr_' || substr(id, 5) WHERE kind = 'cli';

CREATE UNIQUE INDEX idx_agents_user ON agents(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_users_email ON users(lower(email)) WHERE email <> '';

-- The audit log gets user events (created, blocked, role changed, key
-- rotated…). Same rebuild as 006: nothing has a foreign key into events.
CREATE TABLE events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('job', 'resource', 'agent', 'group', 'user')),
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
INSERT INTO events_new (id, ts, entity, entity_id, type, data) SELECT id, ts, entity, entity_id, type, data FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_entity ON events(entity, entity_id);
