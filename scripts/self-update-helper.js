/**
 * @file        scripts/self-update-helper.js
 * @description Root side of the Coordinator's self-update (README §10.2): run by thub-coordinator-update.service
 *              when the dashboard writes an update request, installs the requested version with npm i -g
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
  { execFileSync } = require('node:child_process'),
  { PACKAGES, isValidVersion, compareVersions, npmInstallGlobal } = require('@andrian.yablonskyy/thub-common'),
  { version: installedVersion } = require('../package.json');

// Progress for the dashboard (services/updates.js reads it), next to the
// request: {version, state, message, at} with state installing |
// restarting | failed. Without it the dashboard can't tell a failed or
// never-started update from one still running, and waits forever.
let statusFile = null;
function report(version, state, message = null){
  if (!statusFile){
    return;
  }
  try {
    fs.writeFileSync(statusFile, JSON.stringify({ version, state, message, at: new Date().toISOString() }) + '\n', { mode: 0o644 });
  }
  catch (err){
    console.error(`thub-coordinator-update: could not write ${statusFile}: ${err.message}`);
  }
}

// The request only ever comes from a Coordinator older than `version`.
function restartCoordinator(){
  execFileSync('systemctl', ['restart', 'thub-coordinator.service'], { stdio: 'inherit' });
}

// argv: <request file> <user the Coordinator runs as>. The request file
// is written by the (unprivileged) Coordinator, so only its `version` is
// used, and only if it's a plain semver — the package is fixed.
function main(){
  const [requestFile, user] = process.argv.slice(2);
  if (!requestFile || !user){
    console.error('usage: self-update-helper.js <request file> <user>');
    return 2;
  }
  statusFile = path.join(path.dirname(requestFile), 'update-status.json');

  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  }
  catch (err){
    // Deleted by a previous run (PathModified= also fires on removal).
    if (err.code === 'ENOENT'){
      return 0;
    }
    console.error(`thub-coordinator-update: unreadable request ${requestFile}: ${err.message}`);
    fs.rmSync(requestFile, { force: true });
    return 1;
  }
  fs.rmSync(requestFile, { force: true });

  const target = request?.version;
  if (!isValidVersion(target)){
    console.error('thub-coordinator-update: ignoring request with an invalid version');
    report(String(target), 'failed', 'The update request had an invalid version.');
    return 1;
  }
  // Already installed on disk (e.g. a manual `npm i -g` whose restart never
  // happened) while the running Coordinator is older — it asked, after all.
  // Just restart it onto what's installed instead of leaving it waiting.
  if (compareVersions(installedVersion, target) >= 0){
    console.log(`thub-coordinator-update: v${installedVersion} is already installed (requested v${target}) — restarting the Coordinator onto it`);
    report(target, 'restarting');
    try {
      restartCoordinator();
      return 0;
    }
    catch (err){
      report(target, 'failed', `v${installedVersion} is installed, but restarting the Coordinator failed: ${err.message}`);
      return 1;
    }
  }

  console.log(`thub-coordinator-update: v${installedVersion} -> v${target} (requested by ${request.requestedBy || 'the dashboard'})`);
  report(target, 'installing');
  // SUDO_USER makes the postinstall scripts target the Coordinator's user,
  // as a `sudo npm i -g` by that user would (install-target.js); the
  // postinstall then restarts thub-coordinator on the new version.
  let status;
  try {
    status = npmInstallGlobal(PACKAGES.coordinator, target, { env: { ...process.env, SUDO_USER: user } });
  }
  catch (err){
    report(target, 'failed', `Could not run npm: ${err.message}`);
    return 1;
  }
  if (status !== 0){
    console.error(`thub-coordinator-update: npm i -g failed (exit ${status})`);
    report(target, 'failed', `npm i -g failed (exit ${status}) — see: journalctl -u thub-coordinator-update`);
  }
  return status;
}

process.exit(main());
