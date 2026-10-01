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

// The help page is mostly static text split over partials sharing mixins
// (views/help/_mixins.pug): compiling each file alone doesn't catch a missing
// mixin or a broken include, so render the whole page.
test('help page renders every section with this Coordinator\'s URL', () => {
  const html = pug.renderFile(path.join(VIEWS, 'help', 'index.pug'), {
    user: { username: 'maint', role: 'maintainer', theme: 'auto', canUseDashboard: true },
    can: { operate: true, admin: false },
    roleLabel: (r) => r.charAt(0).toUpperCase() + r.slice(1),
    updates: {},
    messages: [],
    currentPath: '/help',
    active: 'help',
    title: 'Help',
    coordinatorVersion: '1.2.3',
    commonVersion: '1.0.0',
    fmtDate: () => '',
    coordinatorUrl: 'https://thub.example.test'
  });
  for (const id of ['overview', 'use-cases', 'quick-start', 'coordinator', 'agent-setup', 'client-setup',
    'client-machines', 'docker', 'git', 'agent-cli', 'env', 'ci', 'troubleshooting']){
    assert.match(html, new RegExp(`<section[^>]* id="${id}"`), `section #${id}`);
    assert.match(html, new RegExp(`href="#${id}"`), `TOC entry for #${id}`);
  }
  assert.match(html, /thub config set url {3}https:\/\/thub\.example\.test/);
  assert.match(html, /<a class="nav-link d-flex align-items-center active" href="\/help" aria-current="page"/);
  // Troubleshooting: commands and parameters are <code>, placeholders escaped.
  assert.match(html, /<code>journalctl -u thub-client@&lt;instance&gt; -f<\/code>/);
  assert.match(html, /<span>The job is rejected with <code>422<\/code><\/span>/);
  // Code placeholders are escaped, never parsed as tags.
  assert.doesNotMatch(html, /<(url|jobId|groupId|resourceId|work|ref)>/);
});
