/**
 * @file        scripts/install-default-config.js
 * @description npm postinstall: creates ~/.config/thub/coordinator.json on a real global install,
 *              if it doesn't already exist, with a freshly generated sessionSecret rather than a
 *              shared placeholder — so every real installation isn't using the same known secret
 *              for its session cookies and artifact-download HMACs (README §12, §13)
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
  crypto = require('node:crypto'),

  CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'coordinator.json');

// npm only sets this for an actual `npm install -g` — absent for a plain
// local/workspace install (e.g. this monorepo's own `npm install`).
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

// Deliberately minimal, not a copy of the bundled config.json (which uses
// a relative dataDir and a fixed sessionSecret for zero-setup `npm run
// coordinator` in the monorepo — fine there since it's never a real
// deployment). loadConfig()'s own DEFAULTS already cover everything else
// (listen, publicUrl, heartbeat/scheduler/jobs/retention/artifacts), so
// only what genuinely needs to differ for a real standalone install goes
// here:
//   - dataDir: home-anchored, not cwd-relative — a real install shouldn't
//     silently get a different data directory depending on which
//     directory you happened to launch thub-coordinator from.
//   - sessionSecret: freshly random per install. The code's own default
//     ("dev-only-change-me") is fine for local dev but would otherwise
//     mean every real installation nobody got around to changing shares
//     the exact same session-signing key.
//   - clientJoinKey stays unset (null, the code's own default) — auto-
//     registration is opt-in, and there's nothing sensible to
//     auto-generate here since it also has to be copied to every Client.
function defaultContent(){
  return {
    dataDir: path.join(os.homedir(), '.local', 'share', 'thub'),
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
}

// Best-effort and never fails the `npm install` itself. Never overwrites
// an existing file — a re-install/upgrade must not clobber whatever the
// user already configured, and must never regenerate sessionSecret out
// from under a running deployment (that would invalidate every session).
function main(){
  if (!isGlobalInstall() || fs.existsSync(CONFIG_PATH)){
    return;
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultContent(), null, 2) + '\n', { mode: 0o600 });
    console.log(`thub-coordinator: created ${CONFIG_PATH} with a freshly generated sessionSecret`);
  }
  catch (err){
    console.warn(`thub-coordinator: could not create ${CONFIG_PATH} automatically (${err.message}).`);
  }
}

main();
