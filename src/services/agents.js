/**
 * @file        packages/coordinator/src/services/agents.js
 * @description Agent (CI/CD and developer) identity management: create, list, tokens
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

const { v4: uuid } = require('uuid'),
  { generateToken, hashToken } = require('./tokens');

function createAgentsService(db, { events }){
  function get(id){
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  }

  function getByTokenHash(tokenHash){
    return db
      .prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash);
  }

  function list(){
    return db.prepare('SELECT id, name, kind, version, created_at, last_used_at, revoked_at FROM agents ORDER BY created_at DESC').all();
  }

  function create({ name, kind }){
    const id = `agt_${uuid()}`,
      token = generateToken('agt');
    db.prepare(
      'INSERT INTO agents (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, kind, hashToken(token), new Date().toISOString());
    events.record('agent', id, 'agent.created', { name, kind });
    return { agent: get(id), token };
  }

  function revoke(id){
    db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    events.record('agent', id, 'agent.revoked', {});
  }

  // `version` only when the Agent reported one — keeps the last known one otherwise.
  function touchLastUsed(id, version = null){
    db.prepare('UPDATE agents SET last_used_at = ?, version = COALESCE(?, version) WHERE id = ?').run(new Date().toISOString(), version, id);
  }

  return { get, getByTokenHash, list, create, revoke, touchLastUsed };
}

module.exports = { createAgentsService };
