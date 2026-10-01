-- Coordinator settings changed from the dashboard (services/settings.js,
-- /admin/settings). They override the config file — which the sandboxed
-- service can't write — and are overridden by environment variables.
-- `value` is JSON.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
