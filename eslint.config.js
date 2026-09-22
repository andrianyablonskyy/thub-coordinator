/**
 * @file        eslint.config.js
 * @description ESLint flat config for @thub/coordinator: stylistic/promise rules plus Node globals
 *              for server code and browser globals for the dashboard's public/js scripts.
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

const stylistic = require('@stylistic/eslint-plugin'),
  promise = require('eslint-plugin-promise'),
  globals = require('globals');

const rules = {
  // Core JS
  'prefer-const': 'error',
  strict: ['error', 'global'],
  camelcase: [
    'error',
    {
      properties: 'never',
      ignoreGlobals: true,
      ignoreDestructuring: true,
      allow: ['[a-z]+([a-z0-9_])?']
    }
  ],
  'one-var': ['error', { var: 'never', let: 'consecutive', const: 'consecutive' }],
  'no-var': 'error',
  // No logging abstraction exists in this codebase — console.log/warn/error
  // *is* the daemon/server's actual output mechanism, not leftover
  // debugging. Disallowing it would just mean eslint-disable comments on
  // every real call site.
  'no-console': 'off',

  'no-restricted-syntax': [
    'error',
    {
      selector: 'CallExpression[callee.object.name="console"][callee.property.name!=/^(log|warn|error|info|trace)$/]',
      message: 'Unexpected property on console object was called'
    }
  ],

  curly: 'error',

  // Stylistic
  '@stylistic/indent': ['error', 2],
  '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true, mode: 'strict' }],
  '@stylistic/keyword-spacing': ['error', { before: false, after: true }],
  '@stylistic/linebreak-style': ['error', 'unix'],
  '@stylistic/space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
  '@stylistic/space-infix-ops': 'error',
  '@stylistic/space-before-blocks': ['error', 'never'],
  '@stylistic/comma-dangle': ['error', 'never'],
  '@stylistic/max-len': ['error', 160],
  '@stylistic/no-trailing-spaces': ['error', { skipBlankLines: false }],
  '@stylistic/no-multiple-empty-lines': ['error', { max: 1 }],
  '@stylistic/semi': ['error', 'always'],
  '@stylistic/quotes': ['error', 'single'],
  '@stylistic/one-var-declaration-per-line': ['error', 'always'],
  '@stylistic/no-extra-semi': 'error',
  '@stylistic/no-multi-spaces': 'error',
  '@stylistic/no-mixed-spaces-and-tabs': 'error',
  '@stylistic/arrow-parens': ['error', 'always'],
  '@stylistic/arrow-spacing': ['error', { before: true, after: true }],
  '@stylistic/block-spacing': 'error',
  '@stylistic/brace-style': ['error', 'stroustrup'],
  '@stylistic/comma-spacing': ['error', { before: false, after: true }],
  '@stylistic/comma-style': ['error', 'last'],
  '@stylistic/dot-location': ['error', 'property'],
  '@stylistic/function-call-spacing': ['error', 'never'],

  // Promises
  'promise/always-return': ['error', { ignoreLastCallback: true }],
  'promise/param-names': 'off',
  'promise/catch-or-return': ['error', { allowFinally: true }],
  'promise/no-native': 'off',
  'promise/no-nesting': 'off',
  'promise/no-callback-in-promise': 'off',
  'promise/avoid-new': 'off',
  'promise/no-new-statics': 'error',
  'promise/no-return-in-finally': 'warn',
  'promise/valid-params': 'warn'
};

module.exports = [
  { ignores: ['**/node_modules/**', '.data/**', 'tmp/**'] },
  {
    files: ['**/*.{js,cjs,mjs}'],
    ignores: ['public/js/**'],
    plugins: { '@stylistic': stylistic, promise },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules
  },
  {
    files: ['public/js/**/*.js'],
    plugins: { '@stylistic': stylistic, promise },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, bootstrap: 'readonly' }
    },
    rules
  }
];
