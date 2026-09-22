/**
 * @file        packages/coordinator/src/services/tokens.js
 * @description Generates and hashes bearer tokens (README §12)
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

const crypto = require('node:crypto');

// §12: tokens are 256-bit random, stored as SHA-256 hashes, shown once.
function generateToken(prefix) {
  const raw = crypto.randomBytes(32).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { generateToken, hashToken };
