/**
 * @file        packages/coordinator/src/services/updates.js
 * @description Periodic new-version check of the Coordinator, Agent and Client npm packages (README §10.2)
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

const { PACKAGES, fetchLatestVersion, defaultRegistry, isNewer } = require('@andrian.yablonskyy/thub-common'),
  { version: coordinatorVersion } = require('../../package.json');

// Latest published versions, refreshed every `updates.checkIntervalHours`
// and on demand from the dashboard. Kept in memory only — a restart just
// checks again.
function createUpdatesService({ config }){
  const registry = config.updates.registry || defaultRegistry(),
    state = { latest: {}, checkedAt: null, error: null };
  let inFlight = null;

  async function checkNow(){
    // Concurrent callers (timer + a dashboard click) share one check.
    inFlight = inFlight || (async () => {
      const latest = {},
        errors = [];
      await Promise.all(Object.entries(PACKAGES).map(async ([app, pkg]) => {
        try {
          latest[app] = await fetchLatestVersion(pkg, { registry });
        }
        catch (err){
          errors.push(err.message);
        }
      }));
      state.latest = { ...state.latest, ...latest };
      state.checkedAt = new Date().toISOString();
      state.error = errors.length ? errors.join('; ') : null;
      return status();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function status(){
    return {
      ...state,
      coordinatorVersion,
      coordinatorUpdate: isNewer(state.latest.coordinator, coordinatorVersion) ? state.latest.coordinator : null
    };
  }

  // The version a self-update request targets: the latest known one,
  // checking first if nothing has been fetched yet.
  async function targetVersion(app){
    if (!state.latest[app]){
      await checkNow();
    }
    if (!state.latest[app]){
      throw Object.assign(new Error(`Latest ${app} version unknown (${state.error || 'registry unreachable'})`), { status: 503 });
    }
    return state.latest[app];
  }

  function start(){
    const hours = Number(config.updates.checkIntervalHours);
    if (!(hours > 0)){
      return;
    }
    checkNow().catch(() => {});
    const timer = setInterval(() => checkNow().catch(() => {}), hours * 3600 * 1000);
    timer.unref?.();
  }

  return { checkNow, status, targetVersion, start };
}

module.exports = { createUpdatesService };
