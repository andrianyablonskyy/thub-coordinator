-- Dashboard sessions (services/session-store.js), instead of express-session's
-- in-memory store: they survive a restart, and expired ones are pruned.
-- `expires` is epoch milliseconds (the session cookie's own expiry).
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires);
