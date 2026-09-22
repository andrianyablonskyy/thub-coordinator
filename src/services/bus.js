/**
 * @file        packages/coordinator/src/services/bus.js
 * @description In-process event bus used to fan out log/state changes to SSE subscribers (README §3.1)
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

const { EventEmitter } = require('node:events');

// §3.1: "An in-process EventEmitter. The Coordinator is a single process
// by design; SQLite plus one process is enough for tens of runners and
// hundreds of jobs per day."
class Bus extends EventEmitter {}

module.exports = { bus: new Bus() };
