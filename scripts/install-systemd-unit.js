/**
 * @file        scripts/install-systemd-unit.js
 * @description npm postinstall: installs systemd/thub-coordinator.service to /etc/systemd/system on
 *              Linux when root, rendered for the user who ran `sudo npm i -g` and this install's real
 *              node/server.js paths, then enables and (re)starts it (README §13.1)
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
  { isGlobalInstall, isRoot, resolveTargetUser, targetPaths } = require('./install-target'),

  UNIT_NAME = 'thub-coordinator.service',
  UNIT_SRC = path.join(__dirname, '..', 'systemd', UNIT_NAME),
  SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js'),
  UNIT_DEST = `/etc/systemd/system/${UNIT_NAME}`,
  MANUAL_HINT = 'sudo npm i -g @andrian.yablonskyy/thub-coordinator';

// The checked-in unit only has placeholders — fill in the target user and
// wherever *this* install's node and server.js actually are, so it works
// regardless of npm prefix or an nvm-managed Node.
function renderUnit(user, paths){
  return fs.readFileSync(UNIT_SRC, 'utf8')
    .replace(/^User=.*$/m, `User=${user.name}`)
    .replace(/^Group=.*$/m, `Group=${user.gid}`)
    .replace(/^Environment=THUB_COORDINATOR_CONFIG=.*$/m, `Environment=THUB_COORDINATOR_CONFIG=${paths.configPath}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${SERVER_PATH}`)
    .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${paths.dataDir}`);
}

// Best-effort, never fails the `npm install` itself. Runs after
// install-default-config.js, so the config and data dirs the unit points
// at already exist. `restart` (not `start`) so an upgrade picks up the
// new code immediately.
function main(){
  if (process.platform !== 'linux' || !isGlobalInstall()){
    return;
  }
  if (!isRoot()){
    console.log(`\nthub-coordinator: skipping systemd service install (not root). To install it, run:\n  ${MANUAL_HINT}\n`);
    return;
  }

  const user = resolveTargetUser();
  let step = 'write';
  try {
    fs.writeFileSync(UNIT_DEST, renderUnit(user, targetPaths(user)));
    step = 'daemon-reload';
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    step = 'enable';
    execFileSync('systemctl', ['enable', UNIT_NAME], { stdio: 'ignore' });
    step = 'restart';
    execFileSync('systemctl', ['restart', UNIT_NAME], { stdio: 'ignore' });
    console.log(`thub-coordinator: installed and started ${UNIT_DEST} (runs as ${user.name}; logs: journalctl -u ${UNIT_NAME})`);
  }
  catch (err){
    if (step === 'write'){
      console.warn(`thub-coordinator: could not install ${UNIT_DEST} (${err.message}).`);
    }
    else {
      console.warn(
        `thub-coordinator: installed ${UNIT_DEST} but 'systemctl ${step}' failed (${err.message}).\n` +
          `Finish it yourself: sudo systemctl daemon-reload && sudo systemctl enable --now ${UNIT_NAME}`
      );
    }
  }
}

main();
