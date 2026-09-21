-- events.entity's CHECK constraint didn't include 'group' (groups.js's
-- audit calls). SQLite can't alter a CHECK constraint in place, so this
-- rebuilds the table — safe here since nothing has a foreign key into
-- events, unlike resources/jobs.
CREATE TABLE events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('job', 'resource', 'agent', 'group')),
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);

INSERT INTO events_new (id, ts, entity, entity_id, type, data)
  SELECT id, ts, entity, entity_id, type, data FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_entity ON events(entity, entity_id);
