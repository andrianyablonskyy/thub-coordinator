#!/usr/bin/env node
'use strict';

// Local admin tool: operates directly on the Coordinator's SQLite database.
// Used to bootstrap the first dashboard admin and manage agent tokens.
// Resources no longer need an admin action to join — a Client registers
// itself with the shared clientJoinKey (see `join-key generate` below and
// api/resource.js) — this tool only manages a resource after the fact
// (maintenance mode).

const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { bus } = require('../src/services/bus');
const { createEventsService } = require('../src/services/events');
const { createRegistryService } = require('../src/services/registry');
const { createAgentsService } = require('../src/services/agents');
const { createGroupsService } = require('../src/services/groups');
const { createAdminUsersService } = require('../src/services/admin-users');
const { createArtifactsService } = require('../src/services/artifacts');
const { createJobsService } = require('../src/services/jobs');
const { generateToken } = require('../src/services/tokens');

function usage() {
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
`);
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'label') {
        flags.label = flags.label || [];
        flags.label.push(args[++i]);
      } else if (key === 'on') {
        flags.on = true;
      } else if (key === 'off') {
        flags.on = false;
      } else if (key === 'yes') {
        flags.yes = true;
      } else {
        flags[key] = args[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const events = createEventsService(db);
  const registry = createRegistryService(db, { bus, events });
  const agents = createAgentsService(db, { events });
  const adminUsers = createAdminUsersService(db);
  const artifacts = createArtifactsService(db, { config });
  const jobs = createJobsService(db, { bus, events, registry, artifacts, config });
  const groups = createGroupsService(db, { events, registry });

  if (cmd === 'create-admin') {
    const { positional, flags } = parseFlags([sub, ...rest].filter(Boolean));
    const [username, password] = positional;
    if (!username || !password) return usage(), process.exit(4);
    adminUsers.create({ username, password, role: flags.role || 'admin' });
    console.log(`Created ${flags.role || 'admin'} user "${username}"`);
    return;
  }

  if (cmd === 'agent' && sub === 'add') {
    const { positional, flags } = parseFlags(rest);
    const [name] = positional;
    if (!name || !flags.kind) return usage(), process.exit(4);
    const { agent, token } = agents.create({ name, kind: flags.kind });
    console.log(`Agent ${agent.id} created. Token (shown once): ${token}`);
    return;
  }

  if (cmd === 'join-key' && sub === 'generate') {
    const key = generateToken('jk');
    console.log(`Join key: ${key}`);
    console.log('Put it in the Coordinator config as "clientJoinKey" (or THUB_CLIENT_JOIN_KEY),');
    console.log('and on every Client as "joinKey" (or THUB_CLIENT_JOIN_KEY) to let it self-register.');
    return;
  }

  if (cmd === 'resource' && sub === 'maintenance') {
    const { positional, flags } = parseFlags(rest);
    const [resourceId] = positional;
    if (!resourceId || flags.on === undefined) return usage(), process.exit(4);
    registry.setMaintenance(resourceId, flags.on);
    console.log(`Resource ${resourceId} maintenance ${flags.on ? 'enabled' : 'disabled'}`);
    return;
  }

  if (cmd === 'jobs' && sub === 'reset') {
    const { flags } = parseFlags(rest);
    if (!flags.yes) {
      console.error('This cancels every queued/assigned/preparing/running job. Re-run with --yes to confirm.');
      process.exit(4);
    }
    const canceled = jobs.resetQueue();
    console.log(`Canceled ${canceled} active job(s).`);
    return;
  }

  if (cmd === 'jobs' && sub === 'clean') {
    const { flags } = parseFlags(rest);
    if (!flags.yes) {
      console.error('This permanently deletes finished jobs and their logs/artifacts. Re-run with --yes to confirm.');
      process.exit(4);
    }
    const deleted = jobs.cleanHistory();
    console.log(`Deleted ${deleted} finished job(s) and their logs/artifacts.`);
    return;
  }

  if (cmd === 'group' && sub === 'add') {
    const { positional, flags } = parseFlags(rest);
    const [name] = positional;
    if (!name) return usage(), process.exit(4);
    const group = groups.create({ name, comment: flags.comment });
    console.log(`Group ${group.id} created ("${group.name}"). Use it with: thub run --group ${group.id}`);
    return;
  }

  if (cmd === 'group' && sub === 'list') {
    for (const g of groups.list()) {
      console.log(`${g.id}  ${g.name}${g.comment ? '  — ' + g.comment : ''}`);
    }
    return;
  }

  if (cmd === 'group' && sub === 'remove') {
    const { positional } = parseFlags(rest);
    const [groupId] = positional;
    if (!groupId) return usage(), process.exit(4);
    groups.remove(groupId);
    console.log(`Group ${groupId} removed.`);
    return;
  }

  usage();
  process.exit(4);
}

main();
