/**
 * @file        packages/coordinator/src/services/settings.js
 * @description Coordinator settings editable from the dashboard (/admin/settings): stored in the database, layered over the config file
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

const { JOB_RETENTION } = require('./cleanup');

// README §13.2. Precedence, lowest first: built-in default < config file <
// dashboard setting (the `settings` table) < environment variable. The
// dashboard can't write the config file — the systemd unit only lets the
// service write its data directory — so its changes live in the database.
//
// `applies`: "now" — the code reads it on every use, so saving takes effect
// at once; "restart" — read once at startup (timers, middleware), so it
// takes effect when the Coordinator restarts. Settings that could cut the
// dashboard off from the inside (listen, dataDir, sessionSecret) stay in
// the config file.
const int = (min, max) => (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max){
      throw new Error(`must be a whole number from ${min} to ${max}`);
    }
    return n;
  },
  bool = (raw) => raw === true || raw === 'true' || raw === 'on' || raw === '1',
  oneOf = (values) => (raw) => {
    const v = values.find((x) => String(x) === String(raw));
    if (v === undefined){
      throw new Error(`must be one of: ${values.join(', ')}`);
    }
    return v;
  },

  SETTINGS = [
    {
      key: 'publicUrl', group: 'General', label: 'Public URL', applies: 'now', env: 'THUB_PUBLIC_URL', type: 'text',
      help: 'The https:// address Agents, Clients and browsers use. Job links and the dashboard\'s same-origin check use it.',
      parse: (raw) => {
        const s = String(raw).trim().replace(/\/+$/, '');
        let url;
        try {
          url = new URL(s);
        }
        catch {
          throw new Error('must be a URL like https://thub.example.com');
        }
        if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash){
          throw new Error('must be just http(s)://host[:port], without a path');
        }
        return s;
      }
    },
    {
      key: 'clientJoinKey', group: 'General', label: 'Client join key', applies: 'now', env: 'THUB_CLIENT_JOIN_KEY', type: 'secret',
      help: 'The shared secret Clients self-register with (joinKey in their config). Empty turns self-registration off. ' +
        'Running Clients keep working; one with an old key can\'t register again after its next restart.',
      parse: (raw) => {
        const s = String(raw ?? '').trim();
        if (s && s.length < 16){
          throw new Error('must be at least 16 characters (or empty to turn registration off)');
        }
        return s || null;
      }
    },
    {
      key: 'trustProxy', group: 'General', label: 'Trusted proxies', applies: 'restart', type: 'text',
      help: 'Whose X-Forwarded-For/-Proto to believe: loopback (a proxy on this host), a CIDR such as 10.0.0.0/8, ' +
        'a number of hops, or false. Wrong values break HTTPS detection and sign-in behind a proxy.',
      parse: (raw) => {
        const s = String(raw).trim();
        if (s === 'false' || s === 'true'){
          return s === 'true';
        }
        if (/^\d+$/.test(s)){
          return Number(s);
        }
        if (!/^[\w.:/,\s-]+$/.test(s) || !s){
          throw new Error('must be loopback, uniquelocal, linklocal, IP addresses/CIDRs (comma-separated), a hop count, true or false');
        }
        return s;
      }
    },
    {
      key: 'session.secureCookie', group: 'General', label: 'Secure session cookie', applies: 'restart', type: 'select',
      options: ['auto', 'true', 'false'],
      help: 'auto: HTTPS-only whenever the public URL is https://. true/false force it.',
      parse: (raw) => ({ auto: 'auto', true: true, false: false })[String(raw)] ?? oneOf(['auto', 'true', 'false'])(raw)
    },
    {
      key: 'heartbeat.intervalSec', group: 'Heartbeat', label: 'Heartbeat interval (s)', applies: 'now', type: 'number',
      help: 'How often Clients report. They switch to a new value with their next heartbeat (lowering it, the old one is ' +
        'still allowed for a while). Clients older than this setting keep their own heartbeatIntervalSec (10 by default): ' +
        'don\'t go below that while any are connected.',
      parse: int(2, 300)
    },
    {
      key: 'heartbeat.missedLimit', group: 'Heartbeat', label: 'Missed heartbeats allowed', applies: 'now', type: 'number',
      help: 'A Client that misses this many in a row goes OUT_OF_SERVICE, and its running job becomes LOST.',
      parse: int(2, 20)
    },
    {
      key: 'heartbeat.sweepIntervalSec', group: 'Heartbeat', label: 'Check every (s)', applies: 'restart', type: 'number',
      help: 'How often missed heartbeats, unaccepted assignments and job timeouts are checked.',
      parse: int(1, 60)
    },
    {
      key: 'rateLimit.requestsPerMinute', group: 'Rate limits', label: 'Requests per minute', applies: 'now', type: 'number',
      help: 'Per caller: an agent or resource token, a dashboard user, else the IP address. Short bursts are fine; ' +
        'past that, requests get 429 with Retry-After. A Client streaming logs makes up to ~240 a minute. 0: no limit.',
      parse: int(0, 1_000_000)
    },
    {
      key: 'rateLimit.loginPerMinute', group: 'Rate limits', label: 'Sign-in attempts per minute', applies: 'now', type: 'number',
      help: 'Per IP address, against password guessing. 0: no limit.',
      parse: int(0, 10_000)
    },
    {
      key: 'jobs.defaultTimeoutSec', group: 'Jobs', label: 'Default job timeout (s)', applies: 'now', type: 'number',
      help: 'For a job submitted without --timeout.', parse: int(60, 7 * 86400)
    },
    {
      key: 'jobs.maxTimeoutSec', group: 'Jobs', label: 'Maximum job timeout (s)', applies: 'now', type: 'number',
      help: 'A longer --timeout is cut to this.', parse: int(60, 7 * 86400)
    },
    {
      key: 'scheduler.assignAckTimeoutSec', group: 'Scheduler', label: 'Accept timeout (s)', applies: 'now', type: 'number',
      help: 'How long an assigned job waits for its Client to accept it before going back to the queue.', parse: int(5, 600)
    },
    {
      key: 'scheduler.requeueOnLost', group: 'Scheduler', label: 'Retry lost jobs', applies: 'now', type: 'checkbox',
      help: 'Requeue a job once when its Client goes offline mid-job.', parse: bool
    },
    {
      key: 'scheduler.maxQueuedPerAgent', group: 'Scheduler', label: 'Max queued jobs per agent', applies: 'now', type: 'number',
      help: 'Further submissions from that agent are refused until some run.', parse: int(1, 10000)
    },
    {
      key: 'scheduler.tickIntervalSec', group: 'Scheduler', label: 'Safety-net pass (s)', applies: 'restart', type: 'number',
      help: 'The scheduler also runs on every queued job and free Client; this periodic pass only catches anything missed.',
      parse: int(1, 3600)
    },
    {
      key: 'retention.jobRetention', group: 'Retention', label: 'Keep finished jobs', applies: 'now', type: 'select',
      options: Object.keys(JOB_RETENTION), labels: Object.fromEntries(Object.entries(JOB_RETENTION).map(([k, v]) => [k, v.label])),
      help: 'Older finished jobs, with their logs, are deleted hourly. forever: only by Clean up database.',
      parse: oneOf(Object.keys(JOB_RETENTION))
    },
    {
      key: 'updates.checkIntervalMin', group: 'Updates', label: 'Version check every (min)', applies: 'restart', type: 'number',
      help: 'How often to look for new Coordinator/Agent/Client releases. 0 turns the periodic check off.', parse: int(0, 1440)
    },
    {
      key: 'updates.registry', group: 'Updates', label: 'npm registry', applies: 'restart', type: 'text',
      help: 'Empty: the public npm registry (or npm_config_registry). Set it for a private mirror.',
      parse: (raw) => {
        const s = String(raw ?? '').trim();
        if (s && !/^https?:\/\/\S+$/.test(s)){
          throw new Error('must be an http(s):// URL, or empty');
        }
        return s || null;
      }
    }
  ],
  BY_KEY = new Map(SETTINGS.map((s) => [s.key, s])),

  getPath = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj),
  setPath = (obj, key, value) => {
    const parts = key.split('.'),
      last = parts.pop(),
      parent = parts.reduce((o, k) => (o[k] ??= {}), obj);
    parent[last] = value;
  },
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `config` is the live object every service holds: "now" settings are
// written into it, so they take effect on the next use.
function createSettingsService(db, { config, env = process.env }){
  const stmts = {
      all: db.prepare('SELECT key, value, updated_at, updated_by FROM settings'),
      upsert: db.prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ),
      remove: db.prepare('DELETE FROM settings WHERE key = ?')
    },
    // What the config file (plus defaults) said, before any dashboard
    // setting: what "Reset" goes back to.
    fileValues = Object.fromEntries(SETTINGS.map((s) => [s.key, structuredClone(getPath(config, s.key))]));
  let running = null; // the values this process started with (for "after restart")

  function stored(){
    const rows = {};
    for (const r of stmts.all.all()){
      if (BY_KEY.has(r.key)){
        rows[r.key] = { value: JSON.parse(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by };
      }
    }
    return rows;
  }

  const envLocked = (s) => Boolean(s.env && env[s.env]);

  // What each setting resolves to right now: env > dashboard > file.
  function desired(rows = stored()){
    return Object.fromEntries(SETTINGS.map((s) => [
      s.key,
      envLocked(s) ? getPath(config, s.key) : s.key in rows ? rows[s.key].value : fileValues[s.key]
    ]));
  }

  // At startup: put the dashboard's settings into the config every service
  // reads. Then remember what this process runs with.
  function applyAtStartup(){
    const rows = stored();
    // A value saved by an older version that this one no longer accepts is
    // skipped (with a warning), not allowed to stop the Coordinator.
    for (const [key, { value }]of Object.entries(rows)){
      try {
        BY_KEY.get(key).parse(value === null ? '' : value);
      }
      catch (err){
        console.warn(`Ignoring dashboard setting ${key}=${JSON.stringify(value)}: ${err.message}`);
        delete rows[key];
      }
    }
    const want = desired(rows);
    for (const s of SETTINGS){
      setPath(config, s.key, structuredClone(want[s.key]));
    }
    running = structuredClone(want);
    return service;
  }

  // For the settings page.
  function list(){
    const rows = stored(),
      want = desired(rows);
    return SETTINGS.map((s) => ({
      ...s,
      value: want[s.key],
      fileValue: fileValues[s.key],
      source: envLocked(s) ? 'env' : s.key in rows ? 'dashboard' : 'file',
      updatedAt: rows[s.key]?.updatedAt,
      updatedBy: rows[s.key]?.updatedBy,
      pendingRestart: s.applies === 'restart' && !same(want[s.key], running?.[s.key])
    }));
  }

  // `changes`: { key: rawValue } for the settings to set, `reset`: keys to
  // put back to the config file's value. Validates everything first, so a
  // bad value saves nothing. Returns what changed.
  function save({ changes = {}, reset = [] }, { by, guard } = {}){
    const rows = stored(),
      before = desired(rows),
      parsed = {},
      errors = [];
    for (const [key, raw]of Object.entries(changes)){
      const s = BY_KEY.get(key);
      if (!s || envLocked(s) || reset.includes(key)){
        continue;
      }
      try {
        parsed[key] = s.parse(raw);
      }
      catch (err){
        errors.push(`${s.label}: ${err.message}`);
      }
    }
    const after = { ...before, ...parsed };
    for (const key of reset){
      if (BY_KEY.has(key) && !envLocked(BY_KEY.get(key))){
        after[key] = fileValues[key];
      }
    }
    if (after['jobs.defaultTimeoutSec'] > after['jobs.maxTimeoutSec']){
      errors.push('Default job timeout: can\'t be longer than the maximum job timeout');
    }
    if (!errors.length && guard){
      const problem = guard(after);
      if (problem){
        errors.push(problem);
      }
    }
    if (errors.length){
      throw Object.assign(new Error(errors.join('\n')), { status: 400 });
    }

    const now = new Date().toISOString(),
      changed = [];
    db.transaction(() => {
      for (const s of SETTINGS){
        if (envLocked(s)){
          continue;
        }
        if (reset.includes(s.key) && s.key in rows){
          stmts.remove.run(s.key);
        }
        else if (s.key in parsed && !same(parsed[s.key], before[s.key])){
          stmts.upsert.run(s.key, JSON.stringify(parsed[s.key]), now, by || null);
        }
        else {
          continue;
        }
        if (!same(after[s.key], before[s.key])){
          changed.push(s);
        }
      }
    })();
    for (const s of changed){
      if (s.applies === 'now'){
        setPath(config, s.key, structuredClone(after[s.key]));
      }
    }
    return {
      changed: changed.map((s) => s.key),
      now: changed.filter((s) => s.applies === 'now').map((s) => s.key),
      restart: changed.filter((s) => s.applies === 'restart').map((s) => s.key)
    };
  }

  // thub-admin settings reset — the way back if a setting locked you out:
  // the named settings (all when none) go back to the config file's value
  // at the next start.
  function reset(keys = []){
    if (!keys.length){
      return db.prepare('DELETE FROM settings').run().changes;
    }
    return keys.reduce((n, k) => n + stmts.remove.run(k).changes, 0);
  }

  const service = { list, save, reset, applyAtStartup, SETTINGS };
  return service;
}

module.exports = { createSettingsService, SETTINGS };
