/**
 * @file        packages/coordinator/src/db/index.js
 * @description Opens the SQLite database and applies pending schema migrations on startup
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

const fs = require('node:fs'),
  path = require('node:path'),
  Database = require('better-sqlite3');

function openDb(dbPath){
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations'),
    applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id)),

    files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

  for (const file of files){
    if (applied.has(file)){
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8'),
      runMigration = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString()
        );
      });
    runMigration();
  }
}

module.exports = { openDb };
