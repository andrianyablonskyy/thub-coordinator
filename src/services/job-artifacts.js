/**
 * @file        packages/coordinator/src/services/job-artifacts.js
 * @description Artifacts a finished job reports (metadata only): validation, normalization and size formatting
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

// README §7.3. The job's command publishes its files wherever it likes and
// lists them in $THUB_ARTIFACTS_FILE; the Client sends that list with the
// result, and the job keeps only this metadata:
//   { name, size, link, timestamp }
// It comes from the job's own command, so it's treated as untrusted: only
// http(s) links (a `javascript:` one would run in the dashboard when
// clicked), bounded sizes, and entries that don't fit are dropped, not fatal.
const MAX_ARTIFACTS = 500,
  MAX_NAME = 255,
  MAX_LINK = 2048;

// Unix seconds, Unix milliseconds or an ISO date -> ISO string (or null).
function normalizeTimestamp(value){
  let ms = NaN;
  if (typeof value === 'number' && Number.isFinite(value)){
    ms = value < 1e11 ? value * 1000 : value; // 1e11 s is the year 5138: smaller means seconds
  }
  else if (typeof value === 'string' && value.trim()){
    ms = /^\d+(\.\d+)?$/.test(value.trim()) ? normalizeTimestampMs(Number(value)) : Date.parse(value);
  }
  return Number.isFinite(ms) && ms >= 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

function normalizeTimestampMs(n){
  return n < 1e11 ? n * 1000 : n;
}

function normalizeLink(value){
  if (typeof value !== 'string' || value.length > MAX_LINK){
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  }
  catch {
    return null;
  }
}

// -> { artifacts: [...valid, normalized], dropped: <count> }
function sanitizeArtifacts(raw){
  if (!Array.isArray(raw)){
    return { artifacts: [], dropped: raw === undefined || raw === null ? 0 : 1 };
  }
  const artifacts = [];
  let dropped = Math.max(0, raw.length - MAX_ARTIFACTS);
  for (const item of raw.slice(0, MAX_ARTIFACTS)){
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, MAX_NAME) : '',
      link = normalizeLink(item?.link),
      size = Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : null;
    if (!name || !link){
      dropped += 1;
      continue;
    }
    artifacts.push({ name, size, link, timestamp: normalizeTimestamp(item.timestamp) });
  }
  return { artifacts, dropped };
}

// 1233 -> "1.2 KB" (1024-based, as file managers show it).
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function formatBytes(bytes){
  if (!Number.isFinite(bytes) || bytes < 0){
    return '—';
  }
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1){
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

module.exports = { sanitizeArtifacts, normalizeTimestamp, formatBytes, MAX_ARTIFACTS };
