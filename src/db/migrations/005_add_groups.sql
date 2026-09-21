-- Resource groups: an admin-managed way to partition the lab so a job can
-- be constrained to run only on resources in a specific group (§13.1,
-- `thub run --group <id>`). A resource declares which groups it belongs to
-- (0 or more) in its own Client config, same JSON-array-column pattern as
-- `labels` — not a join table, consistent with this schema's existing
-- style and this system's scale (§3.1: tens of runners, not thousands).
CREATE TABLE groups (
  id TEXT PRIMARY KEY,  -- UUID
  name TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE resources ADD COLUMN group_ids TEXT NOT NULL DEFAULT '[]';
