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

const fs = require('node:fs'),
  path = require('node:path'),
  { PACKAGES, fetchLatestVersion, defaultRegistry, isNewer } = require('@andrian.yablonskyy/thub-common'),
  { version: coordinatorVersion } = require('../../package.json');

// Installed by scripts/install-systemd-unit.js; runs the actual `npm i -g`
// as root when the dashboard writes an update request (README §10.2).
const UPDATE_PATH_UNIT = '/etc/systemd/system/thub-coordinator-update.path';

// Latest published versions, refreshed every `updates.checkIntervalMin`
// and on demand from the dashboard. Kept in memory only — a restart just
// checks again.
function createUpdatesService({ config }){
  const registry = config.updates.registry || defaultRegistry(),
    state = { latest: {}, checkedAt: null, error: null, coordinatorPending: null };
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

  // Navbar "Update app" button: hand the latest version to the root
  // thub-coordinator-update helper, whose install restarts this process
  // (so `coordinatorPending` only lasts until then).
  function requestCoordinatorUpdate(requestedBy){
    const target = status().coordinatorUpdate;
    if (!target){
      throw Object.assign(new Error(`Already on the latest version (v${coordinatorVersion}).`), { status: 409 });
    }
    if (!fs.existsSync(UPDATE_PATH_UNIT)){
      throw Object.assign(
        new Error(`Self-update isn't installed on this host (${UPDATE_PATH_UNIT}) — update by hand: thub-admin self-update`),
        { status: 501 }
      );
    }
    fs.writeFileSync(
      path.join(config.dataDir, 'update-request.json'),
      JSON.stringify({ version: target, requestedBy, requestedAt: new Date().toISOString() }) + '\n'
    );
    state.coordinatorPending = target;
    return target;
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
    const minutes = Number(config.updates.checkIntervalMin);
    if (!(minutes > 0)){
      return;
    }
    checkNow().catch(() => {});
    const timer = setInterval(() => checkNow().catch(() => {}), minutes * 60 * 1000);
    timer.unref?.();
  }

  return { checkNow, status, targetVersion, requestCoordinatorUpdate, start };
}

module.exports = { createUpdatesService };
