/**
 * @file        scripts/install-target.js
 * @description Shared by the npm postinstall scripts: resolves which user a global install is for
 *              (the one who ran `sudo npm i -g`, not root) and the paths it gets (README §13)
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
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');

// npm only sets this for an actual `npm install -g` — absent for a plain
// local/workspace install (e.g. this monorepo's own `npm install`).
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

function isRoot(){
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Under `sudo npm i -g`, npm runs postinstall as root with HOME=/root, but
// "~" in README §13 means the person who ran sudo — SUDO_USER. Their home
// comes from the passwd database, since HOME has already been reset.
function lookupUser(name){
  const entry = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
  return { name: entry[0], uid: Number(entry[2]), gid: Number(entry[3]), home: entry[5] };
}

function resolveTargetUser(){
  const sudoUser = process.env.SUDO_USER;
  if (isRoot() && sudoUser && sudoUser !== 'root' && process.platform === 'linux'){
    try {
      return lookupUser(sudoUser);
    }
    catch {
      // fall through to the current user
    }
  }
  const info = os.userInfo();
  return { name: info.username, uid: info.uid, gid: info.gid, home: os.homedir() };
}

// Default layout (README §13): config under ~/.config/thub, runtime data
// (SQLite DB, uploaded artifacts, avatars, work files) under ~/.thub.
// An existing coordinator.json's own dataDir wins over the default, so a
// re-install prepares (and the systemd unit allows writes to) the
// directory the Coordinator will really use.
function targetPaths(user){
  const configDir = path.join(user.home, '.config', 'thub'),
    configPath = path.join(configDir, 'coordinator.json'),
    defaultDataDir = path.join(user.home, '.thub'),
    dataDir = configuredDataDir(configPath) || defaultDataDir;
  return {
    configDir,
    configPath,
    defaultDataDir,
    dataDir,
    dataSubdirs: ['artifacts', 'avatars', 'work'].map((d) => path.join(dataDir, d))
  };
}

function configuredDataDir(configPath){
  try {
    const dataDir = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.dataDir;
    return typeof dataDir === 'string' && path.isAbsolute(dataDir) ? dataDir : null;
  }
  catch {
    return null;
  }
}

module.exports = { isGlobalInstall, isRoot, resolveTargetUser, targetPaths };
