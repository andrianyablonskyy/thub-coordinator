/**
 * @file        packages/coordinator/src/services/groups.js
 * @description Resource group management: create/list/update/remove groups and their membership (README §13.1)
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

const { v4: uuid } = require('uuid');

// Admin-managed resource groups (README §13.1) — a job can be constrained
// to run only on resources that are members of a given group
// (`thub run --group <id>`, job-spec.schema.js's `target.group`).
// Membership itself lives on the resource (registry.js's `group_ids`,
// declared by the Client's own config), not here — this service only
// owns the groups' own identity (id/name/comment).
function createGroupsService(db, { events, registry }){
  function get(id){
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  }

  function list(){
    return db.prepare('SELECT * FROM groups ORDER BY name ASC').all();
  }

  function create({ name, comment }){
    const id = uuid();
    db.prepare('INSERT INTO groups (id, name, comment, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      comment || null,
      new Date().toISOString()
    );
    events.record('group', id, 'group.created', { name, comment });
    return get(id);
  }

  function update(id, { name, comment }){
    const group = get(id);
    if (!group){
      throw Object.assign(new Error('Unknown group'), { status: 404 });
    }
    db.prepare('UPDATE groups SET name = ?, comment = ? WHERE id = ?').run(
      name ?? group.name,
      comment !== undefined ? comment : group.comment,
      id
    );
    events.record('group', id, 'group.updated', { name, comment });
    return get(id);
  }

  // Deletes the group and strips it out of every resource's membership
  // list — a resource whose config still lists this id just stops
  // matching on it, rather than being left with a dangling reference.
  function remove(id){
    const group = get(id);
    if (!group){
      return;
    }
    for (const resource of registry.list()){
      if (resource.group_ids.includes(id)){
        registry.setGroups(resource.id, resource.group_ids.filter((g) => g !== id));
      }
    }
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    events.record('group', id, 'group.deleted', { name: group.name });
  }

  return { get, list, create, update, remove };
}

module.exports = { createGroupsService };
