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
  { PACKAGES, fetchLatestVersion, defaultRegistry, isNewer, compareVersions } = require('@andrian.yablonskyy/thub-common'),
  { version: coordinatorVersion } = require('../../package.json');

// Installed by scripts/install-systemd-unit.js; runs the actual `npm i -g`
// as root when the dashboard writes an update request (README §10.2).
const UPDATE_PATH_UNIT = '/etc/systemd/system/thub-coordinator-update.path',
  // No sign of the root helper by then: the request wasn't picked up.
  PICKUP_TIMEOUT_MS = 60_000,
  // Longer than thub-coordinator-update.service's TimeoutStartSec (15 min).
  INSTALL_TIMEOUT_MS = 20 * 60_000;

// Latest published versions, refreshed every `updates.checkIntervalMin`
// and on demand from the dashboard. Kept in memory only — a restart just
// checks again.
// `pathUnit`, `fetchLatest` and `now` are overridable for tests only.
function createUpdatesService({ config, pathUnit = UPDATE_PATH_UNIT, fetchLatest = fetchLatestVersion, now = Date.now }){
  const registry = config.updates.registry || defaultRegistry(),
    state = { latest: {}, checkedAt: null, error: null, coordinatorPending: null, coordinatorRequestedAt: null, coordinatorUpdateError: null },
    requestFile = path.join(config.dataDir, 'update-request.json'),
    // Written by the root helper (scripts/self-update-helper.js).
    statusFile = path.join(config.dataDir, 'update-status.json');
  let inFlight = null;

  function readHelperStatus(){
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    }
    catch {
      return null;
    }
  }

  function failPending(message){
    state.coordinatorUpdateError = { version: state.coordinatorPending, message, at: new Date().toISOString() };
    state.coordinatorPending = null;
    state.coordinatorRequestedAt = null;
    console.error(`Coordinator self-update failed: ${message}`);
  }

  // A pending update ends with this process being restarted onto the new
  // version. Anything else — the helper reporting failure, never picking
  // the request up, or taking far too long — must end the wait too, or the
  // dashboard shows "Updating…" forever.
  function refreshPending(){
    if (!state.coordinatorPending){
      return;
    }
    const requestedAt = Date.parse(state.coordinatorRequestedAt),
      helper = readHelperStatus(),
      fresh = helper && Date.parse(helper.at) >= requestedAt - 1000;
    if (fresh && helper.state === 'failed'){
      failPending(helper.message || 'The update helper reported a failure — see: journalctl -u thub-coordinator-update');
    }
    else if (!fresh && now() - requestedAt > PICKUP_TIMEOUT_MS){
      failPending(
        fs.existsSync(requestFile)
          ? `The update request wasn't picked up within ${PICKUP_TIMEOUT_MS / 1000} s — is the watcher running? ` +
            'sudo systemctl enable --now thub-coordinator-update.path'
          : 'The update helper started but never reported progress — see: journalctl -u thub-coordinator-update'
      );
    }
    else if (fresh && now() - Date.parse(helper.at) > INSTALL_TIMEOUT_MS){
      failPending(`The update has been "${helper.state}" for over ${INSTALL_TIMEOUT_MS / 60_000} min — see: journalctl -u thub-coordinator-update`);
    }
  }

  // On startup: a helper status for this version (or older) means the
  // update that restarted us is done — clear it.
  function settleHelperStatus(){
    const helper = readHelperStatus();
    if (helper && helper.state !== 'failed' && compareVersions(coordinatorVersion, String(helper.version)) >= 0){
      fs.rmSync(statusFile, { force: true });
      console.log(`Coordinator self-update to v${helper.version} completed`);
    }
  }

  async function checkNow(){
    // Concurrent callers (timer + a dashboard click) share one check.
    inFlight = inFlight || (async () => {
      const latest = {},
        errors = [];
      await Promise.all(Object.entries(PACKAGES).map(async ([app, pkg]) => {
        try {
          latest[app] = await fetchLatest(pkg, { registry });
        }
        catch (err){
          errors.push(err.message);
        }
      }));
      state.latest = { ...state.latest, ...latest };
      state.checkedAt = new Date().toISOString();
      state.error = errors.length ? errors.join('; ') : null;
      // What this check itself got — `latest` keeps earlier results.
      return { ...status(), fetched: Object.keys(latest) };
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function status(){
    refreshPending();
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
    if (!fs.existsSync(pathUnit)){
      throw Object.assign(
        new Error(`Self-update isn't installed on this host (${pathUnit}) — update by hand: thub-admin self-update`),
        { status: 501 }
      );
    }
    const requestedAt = new Date(now()).toISOString();
    // A previous attempt's result mustn't be mistaken for this one's.
    fs.rmSync(statusFile, { force: true });
    fs.writeFileSync(requestFile, JSON.stringify({ version: target, requestedBy, requestedAt }) + '\n');
    state.coordinatorPending = target;
    state.coordinatorRequestedAt = requestedAt;
    state.coordinatorUpdateError = null;
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
    settleHelperStatus();
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
