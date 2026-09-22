/**
 * @file        packages/coordinator/src/services/registry.js
 * @description Resource registry: registration, identity matching by clientId, and lookup for scheduling (README §5.1)
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
  { RESOURCE_STATES, BUSY_SOURCES } = require('@andrian.yablonskyy/test-hub'),
  { generateToken, hashToken } = require('./tokens');

function rowToResource(row){
  if (!row){
    return row;
  }
  return {
    ...row,
    labels: JSON.parse(row.labels || '[]'),
    group_ids: JSON.parse(row.group_ids || '[]'),
    host_info: row.host_info ? JSON.parse(row.host_info) : null
  };
}

function createRegistryService(db, { bus, events }){
  function get(id){
    return rowToResource(db.prepare('SELECT * FROM resources WHERE id = ?').get(id));
  }

  function getByName(name){
    return rowToResource(db.prepare('SELECT * FROM resources WHERE name = ?').get(name));
  }

  function getByClientId(clientId){
    return rowToResource(db.prepare('SELECT * FROM resources WHERE client_id = ?').get(clientId));
  }

  function getByTokenHash(tokenHash){
    return rowToResource(db.prepare('SELECT * FROM resources WHERE token_hash = ?').get(tokenHash));
  }

  function list({ status, type } = {}){
    let sql = 'SELECT * FROM resources WHERE 1=1';
    const params = [];
    if (status){
      sql += ' AND status = ?';
      params.push(status);
    }
    if (type){
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY name ASC';
    return db.prepare(sql).all(...params).map(rowToResource);
  }

  // Self-service registration: gated by the shared client join key (checked
  // by the caller), not by an admin having pre-created the resource.
  //
  // Identity is `clientId` — a UUID the Client generates once and persists
  // in its own .client-id file (§5.1/§8.6) — not `name`. That's what makes
  // this a genuine update-in-place rather than a rename-creates-a-new-
  // resource operation: name, type, labels and host_info are all fully
  // overwritten (not merged) from what the Client declares *this* time,
  // since the Client is the source of truth for its own current identity/
  // capabilities, and status resets to REGISTERED (clearing any stale
  // BUSY/OUT_OF_SERVICE left over from a crashed previous process) unless
  // an admin had explicitly put it in MAINTENANCE, which re-registering
  // doesn't override.
  //
  // A resource created before clientId existed (client_id IS NULL) is
  // adopted by name the first time its Client presents one, rather than
  // rejected as a name conflict. A name already claimed by a *different*,
  // still-live clientId is a real conflict (409) — but if that claim is
  // OUT_OF_SERVICE (no heartbeat in a while — e.g. its .client-id file was
  // lost or its host is gone for good), it's abandoned, not squatted, and
  // this registration is allowed to reclaim it. Anything else (IDLE, BUSY,
  // MAINTENANCE, REGISTERED-but-just-created) means a process might still
  // be actively using that identity, so it stays a hard conflict.
  function registerAuto({ clientId, name, type, labels = [], groups = [], hostInfo }){
    const resourceToken = generateToken('res');
    let existing = getByClientId(clientId);

    if (!existing){
      const nameOwner = getByName(name);
      if (nameOwner){
        const abandoned = nameOwner.status === RESOURCE_STATES.OUT_OF_SERVICE;
        if (nameOwner.client_id && nameOwner.client_id !== clientId && !abandoned){
          throw Object.assign(
            new Error(
              `Resource name "${name}" is already registered by a different client (status: ${nameOwner.status})`
            ),
            { status: 409 }
          );
        }
        existing = nameOwner; // legacy row, same client, or a reclaimed abandoned one
      }
    }
    else if (existing.name !== name){
      const nameOwner = getByName(name);
      if (nameOwner && nameOwner.id !== existing.id){
        if (nameOwner.status !== RESOURCE_STATES.OUT_OF_SERVICE){
          throw Object.assign(
            new Error(`Resource name "${name}" is already used by another client (status: ${nameOwner.status})`),
            { status: 409 }
          );
        }
        // nameOwner is a different, abandoned row squatting on the name
        // `existing` wants to rename into — free it (not delete: keeps its
        // job history intact) instead of hitting the UNIQUE constraint.
        db.prepare('UPDATE resources SET name = ? WHERE id = ?').run(`${nameOwner.name}__stale-${nameOwner.id}`, nameOwner.id);
      }
    }

    if (existing){
      // A fresh process registering is a definitive signal that whatever
      // the previous process was doing is abandoned — tell jobs.js (via
      // the bus, to avoid a registry<->jobs circular dependency) so any
      // job still pointing at this resource is marked LOST now, instead
      // of sitting orphaned until the heartbeat sweeper eventually notices.
      bus.emit('resource.reregistered', { resourceId: existing.id });

      const nextStatus =
        existing.status === RESOURCE_STATES.MAINTENANCE ? RESOURCE_STATES.MAINTENANCE : RESOURCE_STATES.REGISTERED;

      db.prepare(
        `UPDATE resources
         SET token_hash = ?, client_id = ?, name = ?, type = ?, labels = ?, group_ids = ?, host_info = ?,
             status = ?, busy_source = NULL, busy_reason = NULL
         WHERE id = ?`
      ).run(
        hashToken(resourceToken),
        clientId,
        name,
        type,
        JSON.stringify(labels),
        JSON.stringify(groups),
        JSON.stringify(hostInfo || {}),
        nextStatus,
        existing.id
      );

      events.record('resource', existing.id, 'resource.registered', {
        hostInfo,
        name,
        type,
        labels,
        groups,
        reregistered: true
      });
      return { resourceId: existing.id, resourceToken };
    }

    const id = `res_${uuid()}`;
    db.prepare(
      `INSERT INTO resources (id, name, type, status, labels, group_ids, host_info, token_hash, client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      type,
      RESOURCE_STATES.REGISTERED,
      JSON.stringify(labels),
      JSON.stringify(groups),
      JSON.stringify(hostInfo || {}),
      hashToken(resourceToken),
      clientId,
      new Date().toISOString()
    );

    events.record('resource', id, 'resource.registered', { name, type, hostInfo, groups, reregistered: false });
    return { resourceId: id, resourceToken };
  }

  function setGroups(resourceId, groupIds){
    db.prepare('UPDATE resources SET group_ids = ? WHERE id = ?').run(JSON.stringify(groupIds), resourceId);
    return get(resourceId);
  }

  // Reconcile status from a heartbeat's self-reported state (§5.1).
  function heartbeat(resourceId, { state, activeJobId, localLock, metrics } = {}){
    const resource = get(resourceId);
    if (!resource){
      throw Object.assign(new Error('Unknown resource'), { status: 404 });
    }

    let nextStatus = resource.status,
      busySource = resource.busy_source,
      busyReason = resource.busy_reason;

    if (localLock){
      nextStatus = RESOURCE_STATES.BUSY;
      busySource = BUSY_SOURCES.LOCAL;
    }
    else if (state === 'busy' && activeJobId){
      nextStatus = RESOURCE_STATES.BUSY;
      // busy_source stays whatever the scheduler assigned.
    }
    else if (
      resource.status === RESOURCE_STATES.OUT_OF_SERVICE ||
      resource.status === RESOURCE_STATES.REGISTERED
    ){
      nextStatus = RESOURCE_STATES.IDLE;
      busySource = null;
      busyReason = null;
    }
    else if (resource.status !== RESOURCE_STATES.MAINTENANCE && state === 'idle'){
      nextStatus = RESOURCE_STATES.IDLE;
      busySource = null;
      busyReason = null;
    }

    db.prepare(
      `UPDATE resources
       SET last_heartbeat_at = ?, status = ?, busy_source = ?, busy_reason = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), nextStatus, busySource, busyReason, resourceId);

    if (resource.status !== nextStatus){
      events.record('resource', resourceId, 'resource.status_changed', {
        from: resource.status,
        to: nextStatus
      });
      if (nextStatus === RESOURCE_STATES.IDLE){
        bus.emit('resource.idle', { resourceId });
      }
    }

    return { resource: get(resourceId), statusChanged: resource.status !== nextStatus };
  }

  // §8.4 local lock / unlock via the Client's Unix socket -> daemon -> Coordinator.
  function setLocalLock(resourceId, { locked, reason }){
    const resource = get(resourceId);
    if (!resource){
      throw Object.assign(new Error('Unknown resource'), { status: 404 });
    }

    if (locked){
      if (resource.status === RESOURCE_STATES.BUSY && resource.busy_source !== BUSY_SOURCES.LOCAL){
        throw Object.assign(new Error('Resource is running a job'), { status: 409 });
      }
      db.prepare('UPDATE resources SET status = ?, busy_source = ?, busy_reason = ? WHERE id = ?').run(
        RESOURCE_STATES.BUSY,
        BUSY_SOURCES.LOCAL,
        reason || null,
        resourceId
      );
      events.record('resource', resourceId, 'resource.locked', { reason });
    }
    else {
      db.prepare('UPDATE resources SET status = ?, busy_source = NULL, busy_reason = NULL WHERE id = ?').run(
        RESOURCE_STATES.IDLE,
        resourceId
      );
      events.record('resource', resourceId, 'resource.unlocked', {});
      bus.emit('resource.idle', { resourceId });
    }
    return get(resourceId);
  }

  function markOutOfService(resourceId){
    const resource = get(resourceId);
    if (!resource || resource.status === RESOURCE_STATES.OUT_OF_SERVICE){
      return resource;
    }
    db.prepare('UPDATE resources SET status = ? WHERE id = ?').run(RESOURCE_STATES.OUT_OF_SERVICE, resourceId);
    events.record('resource', resourceId, 'resource.oos', {});
    return get(resourceId);
  }

  function markIdleAfterJob(resourceId){
    db.prepare(
      `UPDATE resources
       SET status = ?, busy_source = NULL, busy_reason = NULL, last_job_finished_at = ?
       WHERE id = ? AND status != ?`
    ).run(RESOURCE_STATES.IDLE, new Date().toISOString(), resourceId, RESOURCE_STATES.MAINTENANCE);
    bus.emit('resource.idle', { resourceId });
  }

  function setMaintenance(resourceId, enabled){
    const resource = get(resourceId);
    if (!resource){
      throw Object.assign(new Error('Unknown resource'), { status: 404 });
    }
    const status = enabled ? RESOURCE_STATES.MAINTENANCE : RESOURCE_STATES.IDLE;
    db.prepare('UPDATE resources SET status = ? WHERE id = ?').run(status, resourceId);
    events.record('resource', resourceId, enabled ? 'resource.maintenance_on' : 'resource.maintenance_off', {});
    if (!enabled){
      bus.emit('resource.idle', { resourceId });
    }
    return get(resourceId);
  }

  // Used by the scheduler under a single write transaction.
  function assignToJob(resourceId, busySource){
    db.prepare('UPDATE resources SET status = ?, busy_source = ? WHERE id = ?').run(
      RESOURCE_STATES.BUSY,
      busySource,
      resourceId
    );
  }

  function findIdleCandidates(type, labels, groupId){
    const rows = db
      .prepare('SELECT * FROM resources WHERE status = ? AND type = ?')
      .all(RESOURCE_STATES.IDLE, type)
      .map(rowToResource);
    return rows.filter(
      (r) => labels.every((l) => r.labels.includes(l)) && (!groupId || r.group_ids.includes(groupId))
    );
  }

  function everSatisfiable(type, labels, groupId){
    const rows = db.prepare('SELECT * FROM resources WHERE type = ?').all(type).map(rowToResource);
    return rows.some(
      (r) => labels.every((l) => r.labels.includes(l)) && (!groupId || r.group_ids.includes(groupId))
    );
  }

  return {
    get,
    getByName,
    getByClientId,
    getByTokenHash,
    list,
    registerAuto,
    setGroups,
    heartbeat,
    setLocalLock,
    markOutOfService,
    markIdleAfterJob,
    setMaintenance,
    assignToJob,
    findIdleCandidates,
    everSatisfiable
  };
}

module.exports = { createRegistryService };
