/**
 * @file        packages/coordinator/test/agents.test.js
 * @description Tests: agent rename (dashboard Edit) — a label only; the token keeps working
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
  { openDb } = require('../src/db'),
  { createEventsService } = require('../src/services/events'),
  { createAgentsService } = require('../src/services/agents'),
  { hashToken } = require('../src/services/tokens');

test('renaming an agent changes only its name; its token keeps authenticating', () => {
  const db = openDb(':memory:'),
    agents = createAgentsService(db, { events: createEventsService(db) }),
    { agent, token } = agents.create({ name: 'ci-old', kind: 'ci' });

  assert.equal(agents.rename(agent.id, '  ci-firmware  ').name, 'ci-firmware');
  assert.equal(agents.getByTokenHash(hashToken(token)).id, agent.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = \'agent.renamed\'').get().n, 1);

  agents.rename(agent.id, 'ci-firmware'); // unchanged: no new event
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = \'agent.renamed\'').get().n, 1);

  assert.throws(() => agents.rename(agent.id, '   '), /1-100 characters/);
  assert.throws(() => agents.rename(agent.id, 'x'.repeat(101)), /1-100 characters/);
  assert.throws(() => agents.rename('agt_nope', 'x'), /Unknown agent/);
});
