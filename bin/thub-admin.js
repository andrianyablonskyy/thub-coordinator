#!/usr/bin/env node

/**
 * @file        packages/coordinator/bin/thub-admin.js
 * @description Local operator CLI: admin/agent/resource/group/job management, talks to SQLite directly (README §13.1)
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

// Local admin tool: operates directly on the Coordinator's SQLite database.
// Used to bootstrap the first dashboard admin and manage agent tokens.
// Resources no longer need an admin action to join — a Client registers
// itself with the shared clientJoinKey (see `join-key generate` below and
// api/resource.js) — this tool only manages a resource after the fact
// (maintenance mode).

const { loadConfig } = require('../src/config'),
  { openDb } = require('../src/db'),
  { bus } = require('../src/services/bus'),
  { createEventsService } = require('../src/services/events'),
  { createRegistryService } = require('../src/services/registry'),
  { createAgentsService } = require('../src/services/agents'),
  { createGroupsService } = require('../src/services/groups'),
  { createAdminUsersService } = require('../src/services/admin-users'),
  { createArtifactsService } = require('../src/services/artifacts'),
  { createJobsService } = require('../src/services/jobs'),
  { generateToken } = require('../src/services/tokens'),
  { PACKAGES, fetchLatestVersion, isNewer, isValidVersion, npmBin } = require('@andrian.yablonskyy/thub-common'),
  { spawnSync } = require('node:child_process'),
  { version: installedVersion } = require('../package.json');

function usage(){
  console.log(`Usage:
  thub-admin create-admin <username> <password> [--role admin|viewer]
  thub-admin agent add <name> --kind ci|cli
  thub-admin join-key generate
  thub-admin resource maintenance <resourceId> --on|--off
  thub-admin jobs reset --yes     Cancel every queued/assigned/preparing/running job
  thub-admin jobs clean --yes     Permanently delete finished jobs, logs and artifacts
  thub-admin group add <name> [--comment <text>]
  thub-admin group list
  thub-admin group remove <groupId>
  thub-admin check-update         Compare this Coordinator with the latest published version
  thub-admin self-update [--to X.Y.Z]
                                  Update this Coordinator (sudo npm i -g; restarts the service)
`);
}

function parseFlags(args){
  const positional = [],
    flags = {};
  for (let i = 0; i < args.length; i++){
    const a = args[i];
    if (a.startsWith('--')){
      const key = a.slice(2);
      if (key === 'label'){
        flags.label = flags.label || [];
        flags.label.push(args[++i]);
      }
      else if (key === 'on'){
        flags.on = true;
      }
      else if (key === 'off'){
        flags.on = false;
      }
      else if (key === 'yes'){
        flags.yes = true;
      }
      else {
        flags[key] = args[++i];
      }
    }
    else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// The Coordinator is only ever updated by hand (README §10.2) — never
// from the dashboard. Neither command needs the database.
async function updateCommand(cmd, args){
  const { flags } = parseFlags(args),
    latest = await fetchLatestVersion(PACKAGES.coordinator);
  if (cmd === 'check-update'){
    console.log(`Installed: v${installedVersion}  Latest: v${latest}`);
    console.log(isNewer(latest, installedVersion) ? 'Update available: thub-admin self-update' : 'Up to date.');
    return 0;
  }
  const target = flags.to || latest;
  if (!isValidVersion(target)){
    console.error(`Invalid version "${target}"`);
    return 4;
  }
  if (!flags.to && !isNewer(target, installedVersion)){
    console.log(`Already on v${installedVersion} (latest v${latest}).`);
    return 0;
  }
  // Root, via sudo, so the postinstall re-renders and restarts the
  // thub-coordinator service for the right user (SUDO_USER).
  const npmArgs = ['i', '-g', `${PACKAGES.coordinator}@${target}`],
    isRoot = process.getuid?.() === 0,
    [bin, argv] = isRoot ? [npmBin(), npmArgs] : ['sudo', [npmBin(), ...npmArgs]];
  console.log(`Updating Coordinator v${installedVersion} -> v${target}: ${[bin, ...argv].join(' ')}`);
  return spawnSync(bin, argv, { stdio: 'inherit' }).status ?? 1;
}

function main(){
  const [, , cmd, sub, ...rest] = process.argv;
  if (cmd === 'check-update' || cmd === 'self-update'){
    return updateCommand(cmd, [sub, ...rest].filter(Boolean))
      .then((code) => process.exit(code))
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
  }

  const config = loadConfig(),
    db = openDb(config.dbPath),
    events = createEventsService(db),
    registry = createRegistryService(db, { bus, events }),
    agents = createAgentsService(db, { events }),
    adminUsers = createAdminUsersService(db),
    artifacts = createArtifactsService(db, { config }),
    jobs = createJobsService(db, { bus, events, registry, artifacts, config }),
    groups = createGroupsService(db, { events, registry });

  if (cmd === 'create-admin'){
    const { positional, flags } = parseFlags([sub, ...rest].filter(Boolean)),
      [username, password] = positional;
    if (!username || !password){
      return usage(), process.exit(4);
    }
    adminUsers.create({ username, password, role: flags.role || 'admin' });
    console.log(`Created ${flags.role || 'admin'} user "${username}"`);
    return;
  }

  if (cmd === 'agent' && sub === 'add'){
    const { positional, flags } = parseFlags(rest),
      [name] = positional;
    if (!name || !flags.kind){
      return usage(), process.exit(4);
    }
    const { agent, token } = agents.create({ name, kind: flags.kind });
    console.log(`Agent ${agent.id} created. Token (shown once): ${token}`);
    return;
  }

  if (cmd === 'join-key' && sub === 'generate'){
    const key = generateToken('jk');
    console.log(`Join key: ${key}`);
    console.log('Put it in the Coordinator config as "clientJoinKey" (or THUB_CLIENT_JOIN_KEY),');
    console.log('and on every Client as "joinKey" (or THUB_CLIENT_JOIN_KEY) to let it self-register.');
    return;
  }

  if (cmd === 'resource' && sub === 'maintenance'){
    const { positional, flags } = parseFlags(rest),
      [resourceId] = positional;
    if (!resourceId || flags.on === undefined){
      return usage(), process.exit(4);
    }
    registry.setMaintenance(resourceId, flags.on);
    console.log(`Resource ${resourceId} maintenance ${flags.on ? 'enabled' : 'disabled'}`);
    return;
  }

  if (cmd === 'jobs' && sub === 'reset'){
    const { flags } = parseFlags(rest);
    if (!flags.yes){
      console.error('This cancels every queued/assigned/preparing/running job. Re-run with --yes to confirm.');
      process.exit(4);
    }
    const canceled = jobs.resetQueue();
    console.log(`Canceled ${canceled} active job(s).`);
    return;
  }

  if (cmd === 'jobs' && sub === 'clean'){
    const { flags } = parseFlags(rest);
    if (!flags.yes){
      console.error('This permanently deletes finished jobs and their logs/artifacts. Re-run with --yes to confirm.');
      process.exit(4);
    }
    const deleted = jobs.cleanHistory();
    console.log(`Deleted ${deleted} finished job(s) and their logs/artifacts.`);
    return;
  }

  if (cmd === 'group' && sub === 'add'){
    const { positional, flags } = parseFlags(rest),
      [name] = positional;
    if (!name){
      return usage(), process.exit(4);
    }
    const group = groups.create({ name, comment: flags.comment });
    console.log(`Group ${group.id} created ("${group.name}"). Use it with: thub run --group ${group.id}`);
    return;
  }

  if (cmd === 'group' && sub === 'list'){
    for (const g of groups.list()){
      console.log(`${g.id}  ${g.name}${g.comment ? '  — ' + g.comment : ''}`);
    }
    return;
  }

  if (cmd === 'group' && sub === 'remove'){
    const { positional } = parseFlags(rest),
      [groupId] = positional;
    if (!groupId){
      return usage(), process.exit(4);
    }
    groups.remove(groupId);
    console.log(`Group ${groupId} removed.`);
    return;
  }

  usage();
  process.exit(4);
}

main();
