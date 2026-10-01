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

const { compareVersions } = require('@andrian.yablonskyy/thub-common'),
  { v4: uuid } = require('uuid'),
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
    return db.prepare(`SELECT id, name, kind, user_id, group_id, version, update_to, created_at, last_used_at, revoked_at, token_created_at
                       FROM agents WHERE deleted_at IS NULL ORDER BY created_at DESC`).all();
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

  // Dashboard "Edit": the name is only a label (the token is what
  // authenticates), so renaming never affects anything using the agent.
  function rename(id, name){
    const agent = get(id),
      trimmed = typeof name === 'string' ? name.trim() : '';
    if (!agent){
      throw Object.assign(new Error('Unknown agent'), { status: 404 });
    }
    if (!trimmed || trimmed.length > 100){
      throw Object.assign(new Error('Agent name must be 1-100 characters'), { status: 400 });
    }
    if (trimmed !== agent.name){
      db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(trimmed, id);
      events.record('agent', id, 'agent.renamed', { from: agent.name, to: trimmed });
    }
    return get(id);
  }

  // The resource group a CI token's jobs run in (§13.1), set on CI tokens:
  // an existing group's id, or null for any resource.
  function setGroup(id, groupId){
    const agent = get(id);
    if (!agent){
      throw Object.assign(new Error('Unknown agent'), { status: 404 });
    }
    const group = groupId || null;
    if (group && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(group)){
      throw Object.assign(new Error('Unknown group'), { status: 400 });
    }
    if (group !== (agent.group_id || null)){
      db.prepare('UPDATE agents SET group_id = ? WHERE id = ?').run(group, id);
      events.record('agent', id, 'agent.group_set', { from: agent.group_id || null, to: group });
    }
    return get(id);
  }

  // CI tokens page: a new token for the same agent — the old one stops
  // working at once (a revoked token comes back with it). Returned once;
  // the row, and so its jobs and name, stay the same.
  function rotateToken(id){
    const agent = get(id);
    if (!agent || agent.deleted_at){
      throw Object.assign(new Error('Unknown agent'), { status: 404 });
    }
    if (agent.user_id){
      throw Object.assign(new Error('A user\'s key is replaced on Users, not here'), { status: 400 });
    }
    const token = generateToken('agt');
    db.prepare('UPDATE agents SET token_hash = ?, token_created_at = ?, revoked_at = NULL WHERE id = ?').run(hashToken(token), new Date().toISOString(), id);
    events.record('agent', id, 'agent.token_rotated', { name: agent.name });
    return token;
  }

  // CI tokens page: gone from the list, its token revoked; the row stays for
  // the jobs that reference it (they keep showing its name).
  function remove(id){
    const agent = get(id);
    if (!agent || agent.deleted_at){
      throw Object.assign(new Error('Unknown agent'), { status: 404 });
    }
    if (agent.user_id){
      throw Object.assign(new Error('A user\'s key is managed on Users, not here'), { status: 400 });
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE agents SET deleted_at = ?, revoked_at = COALESCE(revoked_at, ?), update_to = NULL WHERE id = ?').run(now, now, id);
    events.record('agent', id, 'agent.deleted', { name: agent.name });
    return agent;
  }

  function revoke(id){
    db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    events.record('agent', id, 'agent.revoked', {});
  }

  // `version` only when the Agent reported one — keeps the last known one
  // otherwise. Reporting the requested update's version (or newer) is what
  // completes a self-update request.
  function touchLastUsed(id, version = null){
    db.prepare('UPDATE agents SET last_used_at = ?, version = COALESCE(?, version) WHERE id = ?').run(new Date().toISOString(), version, id);
    const agent = get(id);
    if (agent?.update_to && agent.version && compareVersions(agent.version, agent.update_to) >= 0){
      db.prepare('UPDATE agents SET update_to = NULL WHERE id = ?').run(id);
      events.record('agent', id, 'agent.updated', { version: agent.version });
    }
  }

  // Self-update request (README §10.2): the Agent picks it up on its next
  // run. `version` null cancels a pending one.
  function setUpdateTo(id, version){
    const agent = get(id);
    if (!agent || agent.revoked_at){
      throw Object.assign(new Error('Unknown or revoked agent'), { status: 404 });
    }
    db.prepare('UPDATE agents SET update_to = ? WHERE id = ?').run(version, id);
    events.record('agent', id, version ? 'agent.update_requested' : 'agent.update_canceled', { version });
  }

  // Every active agent not already on `version` or newer.
  function requestUpdateAll(version){
    const ids = db.prepare('SELECT id, version FROM agents WHERE revoked_at IS NULL').all()
      .filter((a) => !a.version || compareVersions(a.version, version) < 0)
      .map((a) => a.id);
    ids.forEach((id) => setUpdateTo(id, version));
    return ids.length;
  }

  return { get, getByTokenHash, list, create, rename, setGroup, rotateToken, remove, revoke, touchLastUsed, setUpdateTo, requestUpdateAll };
}

module.exports = { createAgentsService };
