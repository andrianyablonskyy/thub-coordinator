/**
 * @file        packages/coordinator/src/services/session-store.js
 * @description Dashboard session store in the Coordinator's SQLite database: survives restarts, prunes expired sessions
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

const session = require('express-session');

// express-session's default MemoryStore loses every session on a restart,
// never drops expired ones (memory only grows) and warns against itself in
// production. This one keeps them in the `sessions` table (migration 022),
// so signing in survives a Coordinator restart or self-update, and an
// expired session is deleted when read and by a periodic sweep.
const PRUNE_INTERVAL_MS = 15 * 60 * 1000,
  // A session without a cookie expiry (never the case here: routes.js sets
  // each user's idle timeout) is kept this long.
  FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store{
  constructor(db, { pruneIntervalMs = PRUNE_INTERVAL_MS, now = Date.now } = {}){
    super();
    this.now = now;
    this.stmts = {
      get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
      ),
      touch: db.prepare('UPDATE sessions SET sess = ?, expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires > ?'),
      clear: db.prepare('DELETE FROM sessions')
    };
    if (pruneIntervalMs > 0){
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  expiresOf(sess){
    const at = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(at) ? at : this.now() + FALLBACK_TTL_MS;
  }

  // Each method answers through `cb`, as express-session expects; errors
  // (a locked or broken database) go there too instead of throwing.
  run(cb, fn){
    let result;
    try {
      result = fn();
    }
    catch (err){
      return cb?.(err);
    }
    cb?.(null, result);
  }

  get(sid, cb){
    this.run(cb, () => {
      const row = this.stmts.get.get(sid);
      if (!row){
        return null;
      }
      if (row.expires <= this.now()){
        this.stmts.destroy.run(sid);
        return null;
      }
      return JSON.parse(row.sess);
    });
  }

  set(sid, sess, cb){
    this.run(cb, () => {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiresOf(sess));
    });
  }

  // Called for a request that didn't change the session: moves its expiry
  // (rolling idle timeout, §10.1). A passive live-update request leaves the
  // cookie's expiry as it was (server.js), so this writes the same value.
  touch(sid, sess, cb){
    this.run(cb, () => {
      this.stmts.touch.run(JSON.stringify(sess), this.expiresOf(sess), sid);
    });
  }

  destroy(sid, cb){
    this.run(cb, () => {
      this.stmts.destroy.run(sid);
    });
  }

  length(cb){
    this.run(cb, () => this.stmts.length.get(this.now()).n);
  }

  clear(cb){
    this.run(cb, () => {
      this.stmts.clear.run();
    });
  }

  prune(){
    try {
      return this.stmts.prune.run(this.now()).changes;
    }
    catch {
      return 0; // the next sweep tries again
    }
  }

  close(){
    clearInterval(this.pruneTimer);
  }
}

module.exports = { SqliteSessionStore };
