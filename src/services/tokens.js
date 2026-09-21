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
