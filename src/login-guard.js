/**
 * @file        packages/coordinator/src/login-guard.js
 * @description Sign-in protection: exponential backoff after failed attempts, per IP and per username, and a cap on concurrent password checks
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

// README §12. On top of the per-IP budget for sign-in attempts
// (rate-limit.js): after a few failures in a row, each further failure
// doubles the wait before the next attempt is even considered — checked
// before any password hashing, so a locked-out guesser costs nothing.
//
//  - per IP: from the 5th failure, 1 s, 2 s, 4 s … up to 15 min.
//  - per username: from the 10th, up to 5 min — milder, since anyone can
//    trigger it for a name they know; it still slows guessing one account
//    from many addresses to a crawl, without locking its owner out for long.
//    Applied to any name typed, existing or not, so it reveals nothing.
//
// A success clears both. A record without a failure for an hour is dropped.
const POLICIES = {
    ip: { after: 5, maxSec: 15 * 60 },
    user: { after: 10, maxSec: 5 * 60 }
  },
  FORGET_MS = 60 * 60 * 1000,
  MAX_RECORDS = 50_000,
  // Password checks running at once (scrypt on libuv's 4-thread pool, which
  // file serving shares): beyond this, "busy, retry" instead of queueing.
  MAX_CONCURRENT = 8;

function createLoginGuard({ now = Date.now, maxConcurrent = MAX_CONCURRENT } = {}){
  const records = new Map();
  let inFlight = 0;

  const keysOf = (ip, username) => [
    ['ip', `ip:${ip}`],
    ['user', `user:${String(username ?? '').trim().toLowerCase().slice(0, 128)}`]
  ];

  function record(key){
    const r = records.get(key);
    if (r && now() - r.lastFailure > FORGET_MS){
      records.delete(key);
      return null;
    }
    return r || null;
  }

  // Before checking a password: { ok } or { ok: false, retryAfterSec, reason }.
  function check(ip, username){
    let wait = 0;
    for (const [, key]of keysOf(ip, username)){
      const r = record(key);
      if (r && r.lockedUntil > now()){
        wait = Math.max(wait, r.lockedUntil - now());
      }
    }
    if (wait){
      return { ok: false, reason: 'backoff', retryAfterSec: Math.ceil(wait / 1000) };
    }
    if (inFlight >= maxConcurrent){
      return { ok: false, reason: 'busy', retryAfterSec: 1 };
    }
    return { ok: true };
  }

  // Wraps the password check itself, for the concurrency cap.
  async function run(fn){
    inFlight += 1;
    try {
      return await fn();
    }
    finally {
      inFlight -= 1;
    }
  }

  function failure(ip, username){
    for (const [kind, key]of keysOf(ip, username)){
      const { after, maxSec } = POLICIES[kind],
        r = record(key) || { failures: 0, lockedUntil: 0, lastFailure: 0 };
      r.failures += 1;
      r.lastFailure = now();
      if (r.failures >= after){
        r.lockedUntil = now() + Math.min(maxSec, 2 ** (r.failures - after)) * 1000;
      }
      records.delete(key);
      if (records.size >= MAX_RECORDS){
        records.delete(records.keys().next().value); // the longest-idle one
      }
      records.set(key, r);
    }
  }

  function success(ip, username){
    for (const [, key]of keysOf(ip, username)){
      records.delete(key);
    }
  }

  return { check, run, failure, success, size: () => records.size };
}

module.exports = { createLoginGuard, POLICIES };
