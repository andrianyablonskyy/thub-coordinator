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
  const db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

// better-sqlite3 is a native addon built for one Node.js ABI at install
// time; after a Node major upgrade it must be rebuilt. Without this, the
// only hint is a raw NODE_MODULE_VERSION mismatch from deep in bindings.js.
// The rebuild command keeps the caller's PATH under sudo, since sudo's own
// secure_path often finds a different (older) node than the user's shell
// does — rebuilding with that one just reproduces the same mismatch.
function openDatabase(dbPath){
  try {
    return new Database(dbPath);
  }
  catch (err){
    if (err.code === 'ERR_DLOPEN_FAILED'){
      const builtFor = err.message.match(/NODE_MODULE_VERSION (\d+)/)?.[1],
        pkgDir = path.join(__dirname, '..', '..');
      throw new Error(
        `better-sqlite3 was built for a different Node.js ABI (${builtFor || 'unknown'}) than this one: ` +
          `${process.version}, ABI ${process.versions.modules}, at ${process.execPath}.\n` +
          `Rebuild it with this same node: cd ${pkgDir} && sudo env "PATH=$PATH" npm rebuild better-sqlite3\n` +
          'If `sudo node -v` and `node -v` differ, sudo was using another Node.js for earlier installs.',
        { cause: err }
      );
    }
    throw err;
  }
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
