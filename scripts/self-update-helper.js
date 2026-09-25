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
  { PACKAGES, isValidVersion, compareVersions, npmInstallGlobal } = require('@andrian.yablonskyy/thub-common'),
  { version: installedVersion } = require('../package.json');

// argv: <request file> <user the Coordinator runs as>. The request file
// is written by the (unprivileged) Coordinator, so only its `version` is
// used, and only if it's a plain semver — the package is fixed.
function main(){
  const [requestFile, user] = process.argv.slice(2);
  if (!requestFile || !user){
    console.error('usage: self-update-helper.js <request file> <user>');
    return 2;
  }

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
    return 1;
  }
  if (compareVersions(installedVersion, target) >= 0){
    console.log(`thub-coordinator-update: already on v${installedVersion} (requested v${target})`);
    return 0;
  }

  console.log(`thub-coordinator-update: v${installedVersion} -> v${target} (requested by ${request.requestedBy || 'the dashboard'})`);
  // SUDO_USER makes the postinstall scripts target the Coordinator's user,
  // as a `sudo npm i -g` by that user would (install-target.js); the
  // postinstall then restarts thub-coordinator on the new version.
  const status = npmInstallGlobal(PACKAGES.coordinator, target, { env: { ...process.env, SUDO_USER: user } });
  if (status !== 0){
    console.error(`thub-coordinator-update: npm i -g failed (exit ${status})`);
  }
  return status;
}

process.exit(main());
