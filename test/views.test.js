/**
 * @file        packages/coordinator/test/views.test.js
 * @description Tests: every dashboard Pug template compiles (catches syntax the Pug parser doesn't support, e.g. ??)
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
  path = require('node:path'),
  pug = require('pug');

const VIEWS = path.join(__dirname, '..', 'views');

function pugFiles(dir){
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pugFiles(path.join(dir, e.name)) : e.name.endsWith('.pug') ? [path.join(dir, e.name)] : []);
}

test('every view compiles', () => {
  const files = pugFiles(VIEWS);
  assert.ok(files.length > 10);
  for (const file of files){
    assert.doesNotThrow(() => pug.compileFile(file), `${path.relative(VIEWS, file)}`);
  }
});
