/**
 * @file        packages/coordinator/test/systemd-unit.test.js
 * @description Tests: the shipped systemd unit lets SQLite write its temp files
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');

test('systemd unit: ProtectSystem=strict comes with a private writable /tmp (SQLITE_IOERR_GETTEMPPATH)', () => {
  const unit = fs.readFileSync(path.join(__dirname, '../systemd/thub-coordinator.service'), 'utf8');
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^PrivateTmp=yes$/m);
});
