/**
 * @file        packages/coordinator/src/services/live.js
 * @description Dashboard live updates: detects when what a list page shows (resources, agents, jobs) has changed and notifies subscribers
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

const crypto = require('node:crypto'),
  { ACTIVE_JOB_STATES } = require('@andrian.yablonskyy/thub-common');

// How the dashboard stays current (README §10): the page holds one
// GET /live stream that only says *which* topics changed; it then re-fetches
// itself and swaps the parts that differ (public/js/live.js). Rather than
// every place that changes a resource or agent having to announce it, a
// fingerprint of each topic is recomputed and compared — right away on bus
// events (a job starting or finishing shows up at once) and every
// `intervalMs` as the catch-all for everything else (heartbeats, the
// sweeper, maintenance, renames, update requests, …).
const TOPICS = ['resources', 'agents', 'jobs'],
  BUS_EVENTS = ['job.queued', 'job.assigned', 'job.state', 'job.finished', 'resource.idle', 'resource.reregistered'];

function createLiveService(db, { bus, updates, intervalMs = 5000, debounceMs = 250 } = {}){
  const subscribers = new Set(),
    activeStates = [...ACTIVE_JOB_STATES],
    hash = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('base64'),
    // One cheap query per topic covering everything its pages display.
    // Resources: every column (tens of rows) — last_heartbeat_at included,
    // since the pages show it. Jobs: counts and latest times of the whole
    // table (new, finished and deleted jobs) plus every active job's state.
    queries = {
      resources: () => [db.prepare('SELECT * FROM resources ORDER BY id').all(), updates?.status().latest],
      agents: () => [
        db.prepare('SELECT id, name, kind, version, update_to, last_used_at, revoked_at FROM agents ORDER BY id').all(),
        updates?.status().latest
      ],
      jobs: () => [
        db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS created, MAX(finished_at) AS finished FROM jobs').get(),
        db.prepare(
          `SELECT id, state, resource_id, message FROM jobs WHERE state IN (${activeStates.map(() => '?').join(',')}) ORDER BY id`
        ).all(...activeStates)
      ]
    };
  let fingerprints = null,
    timer = null,
    pending = null;

  function compute(){
    return Object.fromEntries(TOPICS.map((t) => [t, hash(queries[t]())]));
  }

  // Compare with the last fingerprints; tell every subscriber what changed.
  function check(){
    pending = null;
    if (!subscribers.size){
      return [];
    }
    const next = compute(),
      changed = fingerprints ? TOPICS.filter((t) => next[t] !== fingerprints[t]) : [];
    fingerprints = next;
    if (changed.length){
      for (const fn of subscribers){
        try {
          fn(changed);
        }
        catch {
          // one broken subscriber (a closed stream) mustn't stop the others
        }
      }
    }
    return changed;
  }

  // Bus events arrive in bursts (state + log + finished): check once.
  function soon(){
    if (subscribers.size && !pending){
      pending = setTimeout(check, debounceMs);
      pending.unref?.();
    }
  }

  function start(){
    fingerprints = compute();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
    for (const e of BUS_EVENTS){
      bus.on(e, soon);
    }
  }

  function stop(){
    clearInterval(timer);
    clearTimeout(pending);
    timer = pending = null;
    fingerprints = null;
    for (const e of BUS_EVENTS){
      bus.off(e, soon);
    }
  }

  // Nothing runs while no dashboard is open.
  function subscribe(fn){
    subscribers.add(fn);
    if (subscribers.size === 1){
      start();
    }
    return () => {
      if (subscribers.delete(fn) && !subscribers.size){
        stop();
      }
    };
  }

  return { subscribe, check, subscriberCount: () => subscribers.size, TOPICS };
}

module.exports = { createLiveService, TOPICS };
