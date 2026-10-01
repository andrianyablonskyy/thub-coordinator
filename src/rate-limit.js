/**
 * @file        packages/coordinator/src/rate-limit.js
 * @description Request rate limiting: token buckets per credential (agent/resource token, dashboard user), per IP without one; a stricter one for sign-in
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

const { hashToken } = require('./services/tokens');

// README §12. A token bucket per caller: it holds up to `perMinute` tokens,
// refills at `perMinute` a minute, and every request takes one — so a short
// burst (a Client flushing logs, a page loading) goes through while the
// sustained rate stays capped. Kept in memory: the Coordinator is a single
// process by design.
//
// Who the caller is: the credential when the request carries a valid one
// (agent token, resource token, dashboard session), else the client IP —
// unauthenticated calls (sign-in, Client registration), and requests with
// a token that doesn't exist, so a random token per request can't dodge the
// limit. Keying by credential means a whole lab behind one NAT address
// doesn't share a single budget.
const MAX_BUCKETS = 50_000,
  PRUNE_MS = 60_000;

function createBuckets(){
  const buckets = new Map();

  // Takes one token from `key`'s bucket of `capacity`, refilled at
  // `capacity` per minute. Returns { ok, remaining, retryAfterSec }.
  function take(key, capacity, now = Date.now()){
    const ratePerMs = capacity / 60_000;
    let b = buckets.get(key);
    if (!b){
      if (buckets.size >= MAX_BUCKETS){
        buckets.delete(buckets.keys().next().value); // oldest first
      }
      b = { tokens: capacity, at: now };
    }
    else {
      buckets.delete(key); // re-insert below: Map order = least recently used first
      b.tokens = Math.min(capacity, b.tokens + (now - b.at) * ratePerMs);
      b.at = now;
    }
    buckets.set(key, b);
    if (b.tokens >= 1){
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
  }

  // A bucket that has refilled completely is the same as no bucket.
  function prune(capacityOf, now = Date.now()){
    for (const [key, b]of buckets){
      const capacity = capacityOf(key);
      if (b.tokens + (now - b.at) * (capacity / 60_000) >= capacity){
        buckets.delete(key);
      }
    }
  }

  return { take, prune, size: () => buckets.size };
}

// The credential a request carries, if it's a real one: "agent:<id>",
// "resource:<id>" or "user:<id>"; otherwise null (counted by IP).
function credentialOf(req, services){
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Bearer' && token){
    const hash = hashToken(token),
      agent = services.agents.getByTokenHash(hash);
    if (agent){
      return `agent:${agent.id}`;
    }
    const resource = services.registry.getByTokenHash(hash);
    return resource ? `resource:${resource.id}` : null;
  }
  const user = req.session?.user;
  return user ? `user:${user.id}` : null;
}

function tooMany(req, res, retryAfterSec, what){
  const text = `Too many ${what}: try again in ${retryAfterSec} s.`;
  res.set('Retry-After', String(retryAfterSec));
  if (req.originalUrl.startsWith('/api/') || !req.accepts('html')){
    return res.status(429).json({ error: text, retryAfterSec });
  }
  res.status(429).type('text/plain').send(text);
}

// `config.rateLimit` is read on every request, so a change from the
// dashboard (Settings, §13.2) applies at once. 0 turns a limit off.
function createRateLimiter(config, services){
  const buckets = createBuckets(),
    capacityOf = (key) => (key.startsWith('login:') ? config.rateLimit.loginPerMinute : config.rateLimit.requestsPerMinute) || 1,
    pruneTimer = setInterval(() => buckets.prune(capacityOf), PRUNE_MS);
  pruneTimer.unref?.();

  function limit(req, res, next){
    const perMinute = config.rateLimit.requestsPerMinute,
      loginPerMinute = config.rateLimit.loginPerMinute;

    // Sign-in attempts: their own, much smaller budget per IP (password
    // guessing), on top of the general one.
    if (loginPerMinute > 0 && req.method === 'POST' && req.path === '/login'){
      const login = buckets.take(`login:${req.ip}`, loginPerMinute);
      if (!login.ok){
        return tooMany(req, res, login.retryAfterSec, 'sign-in attempts');
      }
    }

    if (!(perMinute > 0)){
      return next();
    }
    const key = credentialOf(req, services) || `ip:${req.ip}`,
      result = buckets.take(key, perMinute);
    res.set({ 'RateLimit-Limit': String(perMinute), 'RateLimit-Remaining': String(result.remaining) });
    if (!result.ok){
      return tooMany(req, res, result.retryAfterSec, 'requests');
    }
    next();
  }

  limit.buckets = buckets;
  limit.stop = () => clearInterval(pruneTimer);
  return limit;
}

module.exports = { createRateLimiter, createBuckets };
