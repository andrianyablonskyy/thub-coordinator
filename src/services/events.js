/**
 * @file        packages/coordinator/src/services/events.js
 * @description Audit log service: records every state change to the events table (README §12)
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

// §12 Audit: "All state changes are written to the events table and
// visible on the dashboard."
function createEventsService(db){
  const insert = db.prepare(
    'INSERT INTO events (ts, entity, entity_id, type, data) VALUES (?, ?, ?, ?, ?)'
  );

  function record(entity, entityId, type, data){
    insert.run(new Date().toISOString(), entity, entityId, type, data ? JSON.stringify(data) : null);
  }

  function recent(limit = 50){
    return db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  }

  return { record, recent };
}

module.exports = { createEventsService };
