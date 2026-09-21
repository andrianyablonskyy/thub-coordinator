'use strict';

const { v4: uuid } = require('uuid');
const { generateToken, hashToken } = require('./tokens');

function createAgentsService(db, { events }) {
  function get(id) {
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  }

  function getByTokenHash(tokenHash) {
    return db
      .prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash);
  }

  function list() {
    return db.prepare('SELECT id, name, kind, created_at, last_used_at, revoked_at FROM agents ORDER BY created_at DESC').all();
  }

  function create({ name, kind }) {
    const id = `agt_${uuid()}`;
    const token = generateToken('agt');
    db.prepare(
      'INSERT INTO agents (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, kind, hashToken(token), new Date().toISOString());
    events.record('agent', id, 'agent.created', { name, kind });
    return { agent: get(id), token };
  }

  function revoke(id) {
    db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    events.record('agent', id, 'agent.revoked', {});
  }

  function touchLastUsed(id) {
    db.prepare('UPDATE agents SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  return { get, getByTokenHash, list, create, revoke, touchLastUsed };
}

module.exports = { createAgentsService };
