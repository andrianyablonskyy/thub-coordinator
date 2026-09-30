/**
 * @file        packages/coordinator/src/services/search.js
 * @description Dashboard search (?q=): splits the query into words; a record matches when every word occurs in one of its fields
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

const MAX_QUERY = 200,
  MAX_TERMS = 10;

// "  Lab-HW  nucleo " -> ['lab-hw', 'nucleo']. Case-insensitive, words in
// any order; capped so a pasted wall of text can't build a huge query.
function parseTerms(q){
  if (typeof q !== 'string'){
    return [];
  }
  return [...new Set(q.slice(0, MAX_QUERY).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
}

// The query as shown back in the search box (trimmed, capped).
function normalizeQuery(q){
  return typeof q === 'string' ? q.slice(0, MAX_QUERY).trim() : '';
}

// In-memory lists (resources, groups, agents): `fields` are the record's
// searchable values — strings, numbers, arrays of them, or null.
function matches(fields, terms){
  if (!terms.length){
    return true;
  }
  const text = fields.flat(Infinity).filter((v) => v !== null && v !== undefined && v !== '').join('\n').toLowerCase();
  return terms.every((t) => text.includes(t));
}

// SQL lists (jobs): every term must match at least one of `expressions`
// (SQL expressions yielding text). LIKE is case-insensitive for ASCII in
// SQLite; % and _ in the query are matched literally.
function likeClause(expressions, terms){
  if (!terms.length){
    return { sql: '', params: [] };
  }
  const one = `(${expressions.map((e) => `COALESCE(${e}, '') LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params = [];
  for (const t of terms){
    const pattern = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(...expressions.map(() => pattern));
  }
  return { sql: terms.map(() => one).join(' AND '), params };
}

module.exports = { parseTerms, normalizeQuery, matches, likeClause, MAX_QUERY };
