'use strict';

const { EventEmitter } = require('node:events');

// §3.1: "An in-process EventEmitter. The Coordinator is a single process
// by design; SQLite plus one process is enough for tens of runners and
// hundreds of jobs per day."
class Bus extends EventEmitter {}

module.exports = { bus: new Bus() };
