/**
 * @file        packages/coordinator/src/config.js
 * @description Coordinator config resolution: config file, env var overrides, and defaults (README §13)
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
  { JOB_RETENTION } = require('./services/cleanup');

// Defaults mirror README.md §13.
const DEFAULTS = {
  listen: '127.0.0.1:8080',
  publicUrl: 'http://localhost:8080',
  // Express `trust proxy`: which proxies' X-Forwarded-For to believe for
  // a Client's external address (resource card). 'loopback' fits the
  // default setup — listening on 127.0.0.1 behind a local reverse proxy.
  trustProxy: 'loopback',
  dataDir: path.join(process.cwd(), '.data'),
  sessionSecret: 'dev-only-change-me',
  session: {
    // The dashboard session cookie's Secure flag (server.js cookieSecure):
    // "auto" = Secure whenever publicUrl is https:// (else per request:
    // Secure only on a connection that is itself HTTPS); true / false force it.
    secureCookie: 'auto'
  },
  // Shared secret Clients present to self-register (see api/resource.js).
  // null disables auto-registration entirely — set it explicitly to turn it on.
  clientJoinKey: null,
  heartbeat: {
    intervalSec: 10,
    missedLimit: 3,
    sweepIntervalSec: 5
  },
  scheduler: {
    assignAckTimeoutSec: 15,
    requeueOnLost: true,
    maxQueuedPerAgent: 20,
    tickIntervalSec: 10
  },
  jobs: {
    defaultTimeoutSec: 1800,
    maxTimeoutSec: 14400
  },
  retention: {
    logRetentionDays: 14,
    artifactRetentionDays: 30,
    // How long a finished job (with its logs, artifacts and events) is kept
    // before the hourly retention task wipes it (services/cleanup.js):
    // 1w | 2w | 1m | 3m | 6m | forever. `forever` keeps everything until a
    // manual cleanup (dashboard Clean up database / thub-admin jobs clean).
    jobRetention: 'forever'
  },
  artifacts: {
    maxUploadMb: 512,
    linkTtlHours: 168
  },
  // New-version check of the Coordinator/Agent/Client packages (README
  // §10.2), every 15 minutes so a new Coordinator's "Update app" button
  // shows up promptly. 0 disables the periodic check; registry null = the
  // public npm registry (or npm_config_registry). The old
  // `checkIntervalHours` (6) is no longer read — installed configs still
  // carry it from their defaults.
  updates: {
    checkIntervalMin: 15,
    registry: null
  }
};

function deepMerge(base, override){
  if (!override){
    return base;
  }
  const out = { ...base };
  for (const [k, v]of Object.entries(override)){
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

// User-level default (§13) — consulted when THUB_COORDINATOR_CONFIG isn't
// set, before falling back to the bundled default below.
const USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'coordinator.json'),

  // Bundled with the package so the Coordinator has something sane to run
  // with out of the box; a real deployment overrides it with
  // THUB_COORDINATOR_CONFIG or ~/.config/thub/coordinator.json (§13).
  PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig(configPath = process.env.THUB_COORDINATOR_CONFIG){
  // An explicitly named config that doesn't exist is an error, not a cue to
  // fall back: silently running on the bundled dev config instead (relative
  // dataDir, placeholder secrets) only surfaces later as a confusing
  // failure far from the real cause, e.g. SQLITE_CANTOPEN.
  if (configPath && !fs.existsSync(configPath)){
    throw new Error(`Coordinator config not found: ${configPath} (from THUB_COORDINATOR_CONFIG)`);
  }
  const candidate = [configPath, USER_CONFIG_PATH, PACKAGE_DEFAULT_CONFIG_PATH].find(
      (p) => p && fs.existsSync(p)
    ),
    fileConfig = candidate ? JSON.parse(fs.readFileSync(candidate, 'utf8')) || {} : {},
    config = deepMerge(DEFAULTS, fileConfig);

  // Environment overrides for the bits you don't want in a committed file.
  if (process.env.THUB_LISTEN){
    config.listen = process.env.THUB_LISTEN;
  }
  if (process.env.THUB_PUBLIC_URL){
    config.publicUrl = process.env.THUB_PUBLIC_URL;
  }
  if (process.env.THUB_DATA_DIR){
    config.dataDir = process.env.THUB_DATA_DIR;
  }
  if (process.env.THUB_SESSION_SECRET){
    config.sessionSecret = process.env.THUB_SESSION_SECRET;
  }
  if (process.env.THUB_CLIENT_JOIN_KEY){
    config.clientJoinKey = process.env.THUB_CLIENT_JOIN_KEY;
  }

  if (![true, false, 'auto'].includes(config.session.secureCookie)){
    throw new Error(
      `session.secureCookie must be "auto", true or false (got ${JSON.stringify(config.session.secureCookie)}) in ${candidate || 'the config'}`
    );
  }

  if (!Object.hasOwn(JOB_RETENTION, config.retention.jobRetention)){
    throw new Error(
      `retention.jobRetention must be one of: ${Object.keys(JOB_RETENTION).join(', ')} ` +
        `(got ${JSON.stringify(config.retention.jobRetention)}) in ${candidate || 'the config'}`
    );
  }

  config.configPath = candidate || null;
  config.dataDir = path.resolve(config.dataDir);

  const [host, port] = config.listen.split(':');
  config.host = host;
  config.port = Number(port);
  config.dbPath = path.join(config.dataDir, 'thub.db');
  config.artifactsDir = path.join(config.dataDir, 'artifacts');
  config.workDir = path.join(config.dataDir, 'work');
  config.avatarsDir = path.join(config.dataDir, 'avatars');

  ensureWritableDir(config.dataDir, config.configPath);
  ensureWritableDir(config.artifactsDir, config.configPath);
  ensureWritableDir(config.avatarsDir, config.configPath);

  return config;
}

// SQLite opens thub.db (plus its -wal/-shm files) inside dataDir, so an
// existing but unwritable dataDir — typically one created by an earlier
// run under sudo — would otherwise fail later as a bare SQLITE_CANTOPEN.
function ensureWritableDir(dir, configPath){
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  }
  catch (err){
    throw new Error(
      `Coordinator data directory ${dir} is not writable by this user (${err.code || err.message}). ` +
        `Fix its ownership, or set dataDir in ${configPath || 'the config'} / THUB_DATA_DIR to a writable path.`
    );
  }
}

module.exports = { loadConfig, DEFAULTS };
