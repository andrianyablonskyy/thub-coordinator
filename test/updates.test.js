/**
 * @file        packages/coordinator/test/updates.test.js
 * @description Tests: Coordinator self-update request lifecycle — the dashboard never waits forever on a stuck update
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { createUpdatesService } = require('../src/services/updates'),
  { version: installed } = require('../package.json');

const NEWER = installed.replace(/\d+$/, (n) => String(Number(n) + 1));

async function setup(){
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-updates-')),
    pathUnit = path.join(dataDir, 'fake.path'),
    clock = { t: Date.parse('2026-09-28T12:00:00Z') };
  fs.writeFileSync(pathUnit, '');
  const updates = createUpdatesService({
    config: { dataDir, updates: {} },
    pathUnit,
    fetchLatest: async () => NEWER,
    now: () => clock.t
  });
  await updates.checkNow();
  const helperSays = (state, message) => fs.writeFileSync(
    path.join(dataDir, 'update-status.json'),
    JSON.stringify({ version: NEWER, state, message, at: new Date(clock.t).toISOString() })
  );
  return { updates, dataDir, clock, helperSays };
}

test('a request is written for the root helper and shows as pending', async () => {
  const { updates, dataDir } = await setup();
  assert.equal(updates.requestCoordinatorUpdate('alice'), NEWER);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'update-request.json'), 'utf8')).version, NEWER);
  assert.equal(updates.status().coordinatorPending, NEWER);
});

test('a request nobody picks up stops pending after the pickup timeout, with the reason', async () => {
  const { updates, clock } = await setup();
  updates.requestCoordinatorUpdate('alice');
  clock.t += 30_000;
  assert.equal(updates.status().coordinatorPending, NEWER); // still within the timeout
  clock.t += 31_000;
  const s = updates.status();
  assert.equal(s.coordinatorPending, null);
  assert.match(s.coordinatorUpdateError.message, /wasn't picked up.*thub-coordinator-update\.path/);
});

test('a helper failure ends the wait at once with its message', async () => {
  const { updates, clock, helperSays } = await setup();
  updates.requestCoordinatorUpdate('alice');
  clock.t += 2000;
  helperSays('installing');
  assert.equal(updates.status().coordinatorPending, NEWER);
  helperSays('failed', 'npm i -g failed (exit 1)');
  const s = updates.status();
  assert.equal(s.coordinatorPending, null);
  assert.deepEqual([s.coordinatorUpdateError.version, s.coordinatorUpdateError.message], [NEWER, 'npm i -g failed (exit 1)']);
});

test('an install that runs far too long times out; a normal one keeps pending', async () => {
  const { updates, clock, helperSays } = await setup();
  updates.requestCoordinatorUpdate('alice');
  helperSays('installing');
  clock.t += 5 * 60_000;
  assert.equal(updates.status().coordinatorPending, NEWER);
  clock.t += 16 * 60_000;
  assert.match(updates.status().coordinatorUpdateError.message, /"installing" for over 20 min/);
});

test('a stale failure from an earlier attempt is not mistaken for the new one', async () => {
  const { updates, clock, helperSays } = await setup();
  helperSays('failed', 'old failure');
  clock.t += 60_000;
  updates.requestCoordinatorUpdate('alice'); // removes the old status
  assert.equal(updates.status().coordinatorPending, NEWER);
  assert.equal(updates.status().coordinatorUpdateError, null);
});

test('on startup, a finished update\'s status is cleared; a failure is kept for the dashboard', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-updates-')),
    statusFile = path.join(dataDir, 'update-status.json'),
    make = () => createUpdatesService({ config: { dataDir, updates: {} }, fetchLatest: async () => installed });

  fs.writeFileSync(statusFile, JSON.stringify({ version: installed, state: 'installing', at: new Date().toISOString() }));
  make().start();
  assert.equal(fs.existsSync(statusFile), false);

  fs.writeFileSync(statusFile, JSON.stringify({ version: NEWER, state: 'failed', at: new Date().toISOString() }));
  make().start();
  assert.equal(fs.existsSync(statusFile), true);
});
