/**
 * @file        scripts/ensure-native-deps.js
 * @description npm postinstall: makes sure better-sqlite3's native addon loads under the Node.js
 *              running this install, rebuilding it in place if not
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

const path = require('node:path'),
  { execFileSync, spawnSync } = require('node:child_process'),
  { isGlobalInstall } = require('./install-target'),

  PKG_DIR = path.join(__dirname, '..');

// Checked in a child process: once a mismatched addon has been dlopen'ed,
// this process keeps the old image mapped, so an in-process retry after
// the rebuild would still see the stale one.
function loads(){
  const res = spawnSync(process.execPath, ['-e', 'new (require(\'better-sqlite3\'))(\':memory:\').close()'], {
    cwd: PKG_DIR,
    encoding: 'utf8'
  });
  if (res.status === 0){
    return true;
  }
  if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(res.stderr)){
    return false;
  }
  throw new Error(res.stderr.trim().split('\n').find((l) => /Error/.test(l)) || `exit ${res.status}`);
}

// Runs better-sqlite3's own install script (prebuild-install, falling back
// to node-gyp) in its own directory. Not `npm rebuild`: under `npm i -g`
// this script inherits npm_config_global=true, which points a nested
// `npm rebuild` at the global prefix instead of this package, where it
// "succeeds" without touching the addon at all.
function rebuild(){
  const dir = path.dirname(require.resolve('better-sqlite3/package.json', { paths: [PKG_DIR] })),
    npmCli = process.env.npm_execpath,
    [cmd, args] = npmCli ? [process.execPath, [npmCli]] : ['npm', []];
  execFileSync(cmd, [...args, 'run-script', 'install'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_global: 'false' }
  });
}

// Re-running `npm i -g` for an already-installed version after a Node
// major upgrade leaves unchanged dependencies alone — including
// better-sqlite3's addon, still built for the old Node ABI — so the server
// then dies with NODE_MODULE_VERSION mismatch at startup. Rebuild it here
// with the same node/npm that's running this install. Best-effort: never
// fails the install itself.
function main(){
  if (!isGlobalInstall()){
    return;
  }
  try {
    if (loads()){
      return;
    }
    console.log(`thub-coordinator: rebuilding better-sqlite3 for Node.js ${process.version} (ABI ${process.versions.modules})`);
    rebuild();
    if (!loads()){
      throw new Error('still fails to load after rebuild');
    }
    console.log('thub-coordinator: better-sqlite3 rebuilt');
  }
  catch (err){
    console.warn(
      `thub-coordinator: better-sqlite3 doesn't load under ${process.execPath} (${process.version}): ${err.message}\n` +
        `Rebuild it manually: cd ${PKG_DIR} && sudo env "PATH=$PATH" npm rebuild better-sqlite3`
    );
  }
}

main();
