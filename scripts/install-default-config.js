/**
 * @file        scripts/install-default-config.js
 * @description npm postinstall: on a real global install, creates the Coordinator's directory layout
 *              (~/.config/thub, ~/.thub and its artifacts/avatars/work subdirs) and, if it
 *              doesn't already exist, ~/.config/thub/coordinator.json with every default option and
 *              a freshly generated sessionSecret (README §12, §13)
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
  crypto = require('node:crypto'),
  { DEFAULTS } = require('../src/config'),
  { isGlobalInstall, isRoot, resolveTargetUser, targetPaths } = require('./install-target');

// Every option loadConfig() knows, written out so the file documents what
// can be changed — not a copy of the bundled config.json (which uses a
// relative dataDir and a fixed sessionSecret for zero-setup `npm run
// coordinator` in the monorepo). What differs from DEFAULTS:
//   - dataDir: home-anchored (~/.thub), not cwd-relative — a real
//     install shouldn't get a different data directory depending on which
//     directory thub-coordinator happened to be launched from.
//   - sessionSecret: freshly random per install, never the shared
//     "dev-only-change-me" default.
//   - clientJoinKey stays null (auto-registration is opt-in, and it also
//     has to be copied to every Client, so there's nothing to generate).
function defaultContent(paths){
  return {
    ...DEFAULTS,
    dataDir: paths.defaultDataDir,
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
}

// Under `sudo npm i -g` everything is created by root in another user's
// home — hand it over, or the Coordinator (running as that user, see
// install-systemd-unit.js) couldn't read its config or write its data.
function chownToUser(p, user){
  if (isRoot() && user.uid !== 0){
    fs.chownSync(p, user.uid, user.gid);
  }
}

// Creates `dir` and chowns every directory this call created along the
// way (e.g. ~/.config, ~/.thub when they didn't exist yet),
// plus `dir` itself.
function mkdirOwned(dir, user){
  const firstCreated = fs.mkdirSync(dir, { recursive: true });
  if (firstCreated){
    const rel = path.relative(firstCreated, dir).split(path.sep).filter(Boolean);
    let current = firstCreated;
    chownToUser(current, user);
    for (const part of rel){
      current = path.join(current, part);
      chownToUser(current, user);
    }
  }
  else {
    chownToUser(dir, user);
  }
}

// Best-effort and never fails the `npm install` itself. Never overwrites
// an existing config file — a re-install/upgrade must not clobber whatever
// the user already configured, and must never regenerate sessionSecret out
// from under a running deployment (that would invalidate every session).
function main(){
  if (!isGlobalInstall()){
    return;
  }
  const user = resolveTargetUser(),
    paths = targetPaths(user);
  try {
    mkdirOwned(paths.configDir, user);
    for (const dir of [paths.dataDir, ...paths.dataSubdirs]){
      mkdirOwned(dir, user);
    }
    if (!fs.existsSync(paths.configPath)){
      fs.writeFileSync(paths.configPath, JSON.stringify(defaultContent(paths), null, 2) + '\n', { mode: 0o600 });
      chownToUser(paths.configPath, user);
      console.log(`thub-coordinator: created ${paths.configPath} with a freshly generated sessionSecret`);
    }
    console.log(`thub-coordinator: data directory is ${paths.dataDir}`);
  }
  catch (err){
    console.warn(`thub-coordinator: could not create ${paths.configPath} / ${paths.dataDir} automatically (${err.message}).`);
  }
}

main();
