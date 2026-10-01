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
  { createJobsService } = require('../src/services/jobs'),
  { createCleanupService } = require('../src/services/cleanup'),
  { generateToken } = require('../src/services/tokens'),
  { createSettingsService } = require('../src/services/settings'),
  { roleLabel, normalizeRole } = require('../src/services/admin-users'),
  { PACKAGES, fetchLatestVersion, isNewer, isValidVersion, npmBin, formatDateTime, parseDateTime } = require('@andrian.yablonskyy/thub-common'),
  { spawnSync } = require('node:child_process'),
  os = require('node:os'),
  { version: installedVersion } = require('../package.json');

// Who the audit log names for a change made here: the OS user running it.
function cliActor(){
  let name = process.env.SUDO_USER || '';
  try {
    name ||= os.userInfo().username;
  }
  catch {
    // no passwd entry (a container's random uid)
  }
  return name ? `thub-admin (${name})` : 'thub-admin';
}

function usage(){
  console.log(`Usage:
  thub-admin user add <username> --email <email> [--role user|maintainer|admin] [--password <p>] [--key]
                                  New user (§10.3). Maintainers/admins without --password get a
                                  temporary one (printed once); --key also creates their access key
  thub-admin user list
  thub-admin user block|unblock <username>
  thub-admin user role <username> user|maintainer|admin
  thub-admin user password <username> <password>    Set a password (no change required)
  thub-admin user key <username>  New access key for them (printed once; the old one stops)
  thub-admin user delete <username>
  thub-admin create-admin <username> <password> [--role admin|maintainer]   (= user add, no email)
  thub-admin agent add <name>      A CI token (pipelines; people get their key with: user key)
  thub-admin join-key generate
  thub-admin resource maintenance <resourceId> --on|--off
  thub-admin jobs reset --yes     Cancel every queued/assigned/preparing/running job
  thub-admin jobs clean --yes [--before "dd/mm/yyyy HH:MM:SS"]
                                  Permanently delete finished jobs (with their logs) and
                                  history from before then (local time; default: now), then
                                  compact the database file
  thub-admin group add <name> [--comment <text>]
  thub-admin group list
  thub-admin group remove <groupId>
  thub-admin settings list        Settings changed from the dashboard (Settings page)
  thub-admin settings reset [<key>...]
                                  Drop them (all, or the named ones) — back to the config
                                  file's values at the next restart; the way back if a
                                  setting locked you out of the dashboard
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
    adminUsers = createAdminUsersService(db, { events }),
    jobs = createJobsService(db, { bus, events, registry, config }),
    groups = createGroupsService(db, { events, registry });

  if (cmd === 'settings' && (sub === 'list' || sub === 'reset')){
    const settings = createSettingsService(db, { config });
    if (sub === 'reset'){
      const n = settings.reset(rest);
      console.log(`Removed ${n} dashboard setting(s). Restart the Coordinator to use the config file's values: sudo systemctl restart thub-coordinator`);
      return;
    }
    const changed = settings.list().filter((s) => s.source === 'dashboard');
    if (!changed.length){
      console.log('No settings changed from the dashboard — everything comes from the config file (or the environment).');
    }
    for (const s of changed){
      console.log(`${s.key} = ${s.type === 'secret' ? '(secret)' : JSON.stringify(s.value)}   (${s.updatedBy || '?'}, ${s.updatedAt})`);
    }
    return;
  }

  // Users (§10.3) — also the way back in when nobody can sign in: unblock or
  // re-role an admin, set a password. Run as the Coordinator's user.
  if (cmd === 'user'){
    const { positional, flags } = parseFlags(rest),
      [username, arg] = positional,
      by = cliActor(),
      need = (u) => {
        const row = adminUsers.getByUsername(u || '');
        if (!row){
          console.error(`No user "${u}"`);
          process.exit(4);
        }
        return row;
      };
    try {
      if (sub === 'list'){
        for (const u of adminUsers.list()){
          const key = u.key ? `…${u.key.hint || '????'}` : 'none';
          console.log(`${u.username.padEnd(24)} ${roleLabel(u.role).padEnd(11)} ${u.blocked ? 'blocked' : 'active '}  ${u.email || '(no email)'}  key: ${key}`);
        }
        return;
      }
      if (sub === 'add'){
        if (!username || !flags.email){
          return usage(), process.exit(4);
        }
        const created = adminUsers.create({ username, email: flags.email, role: flags.role || 'user', password: flags.password, requireEmail: true }, { by });
        console.log(`Created ${roleLabel(created.role)} "${created.username}"`);
        if (created.tempPassword){
          console.log(`Temporary password (shown once; to change at the first sign-in): ${created.tempPassword}`);
        }
        if (rest.includes('--key')){
          console.log(`Access key (shown once): ${adminUsers.issueKey(created.id, { by })}`);
        }
        return;
      }
      const target = need(username);
      if (sub === 'block' || sub === 'unblock'){
        adminUsers.setBlocked(target.id, sub === 'block', { by });
        console.log(`${sub === 'block' ? 'Blocked' : 'Unblocked'} "${target.username}"`);
      }
      else if (sub === 'role'){
        const { tempPassword } = adminUsers.update(target.id, { role: arg }, { by });
        console.log(`"${target.username}" is now ${roleLabel(normalizeRole(arg))}`);
        if (tempPassword){
          console.log(`Temporary password (shown once): ${tempPassword}`);
        }
      }
      else if (sub === 'password'){
        if (!arg){
          return usage(), process.exit(4);
        }
        adminUsers.resetPassword({ username: target.username, password: arg }, { by });
        console.log(`Password of "${target.username}" set`);
      }
      else if (sub === 'key'){
        console.log(`Access key for "${target.username}" (shown once; any previous one has stopped working): ${adminUsers.issueKey(target.id, { by })}`);
      }
      else if (sub === 'delete'){
        if (!flags.yes){
          console.error(`This deletes "${target.username}" for good (their jobs stay). Re-run with --yes to confirm.`);
          process.exit(4);
        }
        adminUsers.remove(target.id, { by });
        console.log(`Deleted "${target.username}"`);
      }
      else {
        return usage(), process.exit(4);
      }
    }
    catch (err){
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'create-admin'){
    const { positional, flags } = parseFlags([sub, ...rest].filter(Boolean)),
      [username, password] = positional;
    if (!username || !password){
      return usage(), process.exit(4);
    }
    adminUsers.create({ username, password, role: flags.role || 'admin' }, { by: cliActor() });
    console.log(`Created ${roleLabel(normalizeRole(flags.role || 'admin'))} user "${username}"`);
    return;
  }

  if (cmd === 'agent' && sub === 'add'){
    const { positional, flags } = parseFlags(rest),
      [name] = positional;
    if (!name){
      return usage(), process.exit(4);
    }
    if (flags.kind && flags.kind !== 'ci'){
      console.error('Agent tokens are for CI only now; a person gets their access key with: thub-admin user key <username>');
      process.exit(4);
    }
    const { agent, token } = agents.create({ name, kind: 'ci' });
    console.log(`CI token ${agent.id} created. Token (shown once): ${token}`);
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
      console.error('This permanently deletes finished jobs and their logs. Re-run with --yes to confirm.');
      process.exit(4);
    }
    const before = flags.before ? parseDateTime(flags.before) : new Date();
    if (!before){
      console.error(`--before "${flags.before}" isn't a date/time in the dd/mm/yyyy HH:MM:SS format`);
      process.exit(4);
    }
    const r = createCleanupService(db, { jobs, config }).cleanup({ before }),
      mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    console.log(
      `Deleted ${r.jobs} finished job(s) and ${r.events} history record(s) from before ${formatDateTime(r.before)}. ` +
        `Database: ${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)}.`
    );
    return;
  }

  if (cmd === 'group' && sub === 'add'){
    const { positional, flags } = parseFlags(rest),
      [name] = positional;
    if (!name){
      return usage(), process.exit(4);
    }
    const group = groups.create({ name, comment: flags.comment });
    console.log(`Group ${group.id} created ("${group.name}"). Give it to users or CI tokens on the dashboard (Users / CI tokens).`);
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
