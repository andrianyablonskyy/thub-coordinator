/**
 * @file        packages/coordinator/src/services/list-prefs.js
 * @description Per-user list view preferences (page size, sort column/direction) for the dashboard's
 *              Jobs and Resources pages (README §10.1), plus the pagination math they share
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

// 'all' shows every record on one page.
const PAGE_SIZES = [10, 25, 50, 100, 'all'],
  DEFAULT_PAGE_SIZE = 25,
  DIRS = ['asc', 'desc'],

  // Sortable columns per page, and each page's default order. The keys are
  // what the URL (?sort=) and the stored profile carry; the pages map them
  // to actual columns (jobs.page's SQL, the resources route's comparators).
  LISTS = {
    jobs: {
      sorts: ['id', 'source', 'user', 'state', 'resource', 'created', 'duration'],
      defaults: { size: DEFAULT_PAGE_SIZE, sort: 'created', dir: 'desc' }
    },
    resources: {
      sorts: ['name', 'type', 'version', 'status', 'heartbeat'],
      defaults: { size: DEFAULT_PAGE_SIZE, sort: 'name', dir: 'asc' }
    },
    agents: {
      sorts: ['name', 'kind', 'version', 'created', 'used', 'status'],
      defaults: { size: DEFAULT_PAGE_SIZE, sort: 'created', dir: 'desc' }
    },
    users: {
      sorts: ['username', 'role', 'status', 'used'],
      defaults: { size: DEFAULT_PAGE_SIZE, sort: 'username', dir: 'asc' }
    }
  };

function parseSize(value){
  if (value === 'all'){
    return 'all';
  }
  const n = Number(value);
  return PAGE_SIZES.includes(n) ? n : undefined;
}

// A complete, valid {size, sort, dir} for `list`: each field from `prefs`
// when valid there, else that page's default.
function normalize(list, prefs = {}){
  const def = LISTS[list];
  if (!def){
    throw Object.assign(new Error(`Unknown list "${list}"`), { status: 400 });
  }
  return {
    size: parseSize(prefs.size) ?? def.defaults.size,
    sort: def.sorts.includes(prefs.sort) ? prefs.sort : def.defaults.sort,
    dir: DIRS.includes(prefs.dir) ? prefs.dir : def.defaults.dir
  };
}

// What a request asks for: the stored prefs, overridden by whichever of
// ?size / ?sort / ?dir the URL carries (invalid values are ignored).
function fromQuery(list, query, stored){
  const base = normalize(list, stored),
    wanted = { ...base };
  if (query.size !== undefined && parseSize(query.size) !== undefined){
    wanted.size = parseSize(query.size);
  }
  if (LISTS[list].sorts.includes(query.sort)){
    wanted.sort = query.sort;
  }
  if (DIRS.includes(query.dir)){
    wanted.dir = query.dir;
  }
  return { prefs: wanted, changed: ['size', 'sort', 'dir'].some((k) => wanted[k] !== base[k]) };
}

// Page window for `total` records: `page` is 1-based and clamped into range.
function paginate(total, size, page){
  const limit = size === 'all' ? Math.max(total, 1) : size,
    pages = Math.max(1, Math.ceil(total / limit)),
    current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages),
    offset = (current - 1) * limit;
  return {
    page: current,
    pages,
    total,
    offset,
    limit,
    from: total ? offset + 1 : 0,
    to: Math.min(offset + limit, total)
  };
}

module.exports = { PAGE_SIZES, DEFAULT_PAGE_SIZE, LISTS, normalize, fromQuery, paginate };
