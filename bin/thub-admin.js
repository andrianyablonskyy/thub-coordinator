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
const { createAdminUsersService } = require('../src/services/admin-users');
const { generateToken } = require('../src/services/tokens');

function usage() {
  console.log(`Usage:
  thub-admin create-admin <username> <password> [--role admin|viewer]
  thub-admin agent add <name> --kind ci|cli
  thub-admin join-key generate
  thub-admin resource maintenance <resourceId> --on|--off
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

  usage();
  process.exit(4);
}

main();
