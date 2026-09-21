'use strict';

// §12 Audit: "All state changes are written to the events table and
// visible on the dashboard."
function createEventsService(db) {
  const insert = db.prepare(
    'INSERT INTO events (ts, entity, entity_id, type, data) VALUES (?, ?, ?, ?, ?)'
  );

  function record(entity, entityId, type, data) {
    insert.run(new Date().toISOString(), entity, entityId, type, data ? JSON.stringify(data) : null);
  }

  function recent(limit = 50) {
    return db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  }

  return { record, recent };
}

module.exports = { createEventsService };
