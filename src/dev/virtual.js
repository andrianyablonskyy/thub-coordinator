/**
 * @file        packages/coordinator/src/dev/virtual.js
 * @description DEV mode only (DEV_MODE=1 with THUB_BOOTSTRAP_ADMIN_PASSWORD): a virtual agent, virtual Clients that
 *              heartbeat and run assigned jobs in-process, and a seeded job history — for working on the dashboard
 *              without real hardware (README §13.1)
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

const { JOB_STATES, ACTIVE_JOB_STATES } = require('@andrian.yablonskyy/thub-common'),
  { hashToken } = require('../services/tokens'),
  { version } = require('../../package.json');

// Fixed, so `thub --token <it>` works against a dev Coordinator without
// copying a fresh token each time. Only ever created in DEV mode.
const DEV_AGENT_NAME = 'virtual-agent',
  DEV_AGENT_TOKEN = 'agt_dev-virtual-agent-token',
  VIRTUAL_CLIENTS = [
    {
      clientId: 'virtual-client-sw-01',
      name: 'virtual-sw-01',
      type: 'sw',
      labels: ['virtual', 'emulator'],
      capabilities: {
        sw: { image: 'dut-emulator:dev', registry: null, allowDockerHub: true, allowJobImages: true, cpus: 2, memory: '2g' }
      },
      address: '10.0.0.41'
    },
    {
      clientId: 'virtual-client-hw-01',
      name: 'virtual-hw-01',
      type: 'hw',
      labels: ['virtual', 'board:nucleo-f401re', 'uart', 'stlink'],
      capabilities: {
        hw: {
          stlinks: [{ path: '/dev/thub/dut1-stlink', index: 1, serial: '066DFF485457725187092834', present: true }],
          uarts: [{ path: '/dev/thub/dut1-uart', index: 1, baudRate: 115200, present: true }],
          usbs: [{ path: '/dev/thub/dut1-usb', index: 1, present: false }],
          relays: [{ channel: 0, baseUrl: 'http://localhost:3000' }],
          power: { method: 'relay' }
        }
      },
      address: '10.0.0.42'
    }
  ],
  // Seeded history: [daysAgo, source, target type, final state, duration s, user].
  HISTORY = [
    [6.8, 'ci', 'hw', 'PASSED', 412, null],
    [6.1, 'cli', 'sw', 'FAILED', 95, 'alice'],
    [5.4, 'ci', 'sw', 'PASSED', 188, null],
    [4.9, 'ci', 'hw', 'ERROR', 31, null],
    [4.2, 'cli', 'hw', 'PASSED', 640, 'bob'],
    [3.6, 'ci', 'sw', 'TIMEOUT', 1800, null],
    [2.7, 'cli', 'sw', 'CANCELED', 44, 'alice'],
    [2.1, 'ci', 'hw', 'PASSED', 377, null],
    [1.3, 'ci', 'sw', 'FAILED', 152, null],
    [0.8, 'cli', 'hw', 'LOST', 260, 'bob'],
    [0.4, 'ci', 'sw', 'PASSED', 201, null],
    [0.1, 'cli', 'sw', 'PASSED', 73, 'alice']
  ],
  // What `lsusb -tvv` prints on a lab host with a DUT slot plugged in.
  VIRTUAL_LSUSB = [
    '/:  Bus 001.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/12p, 480M',
    '    ID 1d6b:0002 Linux Foundation 2.0 root hub',
    '    /sys/bus/usb/devices/usb1  /dev/bus/usb/001/001',
    '    |__ Port 003: Dev 002, If 0, Class=Hub, Driver=hub/4p, 480M',
    '        ID 05e3:0610 Genesys Logic, Inc. Hub',
    '        /sys/bus/usb/devices/1-3  /dev/bus/usb/001/002',
    '        |__ Port 001: Dev 004, If 0, Class=Vendor Specific Class, Driver=, 12M',
    '            ID 0483:3748 STMicroelectronics ST-LINK/V2',
    '            /sys/bus/usb/devices/1-3.1  /dev/bus/usb/001/004',
    '        |__ Port 002: Dev 005, If 0, Class=Vendor Specific Class, Driver=ftdi_sio, 12M',
    '            ID 0403:6001 Future Technology Devices International, Ltd FT232 Serial (UART) IC',
    '            /sys/bus/usb/devices/1-3.2  /dev/bus/usb/001/005',
    '        |__ Port 003: Dev 006, If 0, Class=Communications, Driver=cdc_acm, 12M',
    '            ID 0483:5740 STMicroelectronics Virtual COM Port',
    '            /sys/bus/usb/devices/1-3.3  /dev/bus/usb/001/006',
    '/:  Bus 002.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/4p, 5000M',
    '    ID 1d6b:0003 Linux Foundation 3.0 root hub',
    '    /sys/bus/usb/devices/usb2  /dev/bus/usb/002/001'
  ].join('\n'),
  LOG_SCRIPT = [
    ['runner', 'downloading app.bin (virtual)'],
    ['runner', 'cloning yourorg/firmware-tests at main (virtual)'],
    ['flash', 'st-flash write app.bin 0x08000000 ... done (virtual)'],
    ['uart', '[BOOT] app v1.4.0-dev'],
    ['uart', '[INIT] peripherals ok'],
    ['runner', 'running: sh -c "./ci/run.sh"'],
    ['runner', 'test_boot ............ ok'],
    ['runner', 'test_uart_echo ....... ok'],
    ['runner', 'test_flash_crc ....... ok'],
    ['runner', 'test_power_cycle ..... ok']
  ],

  spec = (type, user, extra = {}) => ({
    target: { type, labels: ['virtual'] },
    command: './ci/run.sh',
    downloads: [{ url: 'https://artifactory.example.com/fw-local/app/1.4.0-dev/app.bin' }],
    ...(type === 'sw' ? { image: 'alpine:3.20' } : {}),
    git: { url: 'https://github.com/yourorg/firmware-tests.git', ref: 'main', depth: 1 },
    ...(user ? { user } : {}),
    meta: { repo: 'yourorg/firmware', branch: 'main', virtual: true },
    ...extra
  });

function isDevMode(env = process.env){
  return env.DEV_MODE === '1' && Boolean(env.THUB_BOOTSTRAP_ADMIN_PASSWORD);
}

// The virtual agent, with its fixed token (re-applied if revoked or changed).
function ensureAgent(services){
  const { db } = services,
    existing = db.prepare('SELECT * FROM agents WHERE name = ?').get(DEV_AGENT_NAME);
  if (existing){
    db.prepare('UPDATE agents SET token_hash = ?, revoked_at = NULL WHERE id = ?').run(hashToken(DEV_AGENT_TOKEN), existing.id);
    return existing.id;
  }
  const id = 'agt_dev-virtual-agent';
  db.prepare('INSERT INTO agents (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, DEV_AGENT_NAME, 'cli', hashToken(DEV_AGENT_TOKEN), new Date().toISOString()
  );
  services.agents.touchLastUsed(id, version);
  return id;
}

// A week of finished jobs in every final state, on the virtual Clients —
// only into an empty jobs table, so restarts don't pile them up.
function seedHistory(services, agentId, resourceIds){
  const { db, jobs, logs } = services;
  if (db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n > 0){
    return 0;
  }
  for (const [daysAgo, source, type, state, durationSec, user]of HISTORY){
    const job = jobs.create({ agentId, source, spec: spec(type, user) }),
      created = Date.now() - daysAgo * 86400000,
      started = created + 20000,
      finished = started + durationSec * 1000,
      ran = state !== 'CANCELED' || durationSec > 0,
      failed = state === 'FAILED' ? 2 : 0;
    db.prepare(
      `UPDATE jobs SET state = ?, resource_id = ?, created_at = ?, assigned_at = ?, started_at = ?, finished_at = ?,
         duration_sec = ?, exit_code = ?, summary = ?, message = ? WHERE id = ?`
    ).run(
      state,
      resourceIds[type],
      new Date(created).toISOString(),
      new Date(created + 5000).toISOString(),
      ran ? new Date(started).toISOString() : null,
      new Date(finished).toISOString(),
      ran ? durationSec : null,
      { PASSED: 0, FAILED: 1 }[state] ?? null,
      JSON.stringify(['PASSED', 'FAILED'].includes(state)
        ? { total: 12, passed: 12 - failed, failed, skipped: 0 }
        : { error: `virtual ${state.toLowerCase()}` }),
      { TIMEOUT: 'Job exceeded its timeout', LOST: 'Resource stopped heartbeating', ERROR: 'Flashing failed (virtual)' }[state] || null,
      job.id
    );
    logs.appendBatch(job.id, LOG_SCRIPT.slice(0, state === 'PASSED' ? LOG_SCRIPT.length : 6).map(([stream, line], i) => ({
      ts: new Date(started + i * 1000).toISOString(), stream, line
    })));
  }
  return HISTORY.length;
}

// Virtual Clients, run in-process: they heartbeat like real ones (so they
// stay IDLE instead of going OUT_OF_SERVICE) and play out any job the
// scheduler assigns them — accept, PREPARING, RUNNING with streamed log
// lines, then a PASSED (mostly) or FAILED result — through the same
// services the Client API uses, so SSE, durations and artifacts all work.
function startVirtualClients(services, config){
  const { registry, jobs, logs, bus } = services,
    intervalMs = config.heartbeat.intervalSec * 1000,
    clients = new Map(); // resourceId -> { def, activity, running }

  for (const def of VIRTUAL_CLIENTS){
    const { resourceId } = registry.registerAuto({
      clientId: def.clientId,
      name: def.name,
      type: def.type,
      labels: def.labels,
      hostInfo: { hostname: `${def.name}.virtual`, platform: 'linux', addresses: [{ iface: 'eth0', address: def.address, family: 'IPv4' }], timeZone: 'UTC' },
      capabilities: { ...def.capabilities, rebootSupported: false },
      // Its "config file": the hw/sw section, as a real Client reports it.
      config: def.type === 'sw'
        ? {
          image: def.capabilities.sw.image,
          allowDockerHub: def.capabilities.sw.allowDockerHub,
          allowJobImages: def.capabilities.sw.allowJobImages,
          cpus: def.capabilities.sw.cpus,
          memory: def.capabilities.sw.memory
        }
        : {
          stlinks: [{ index: 1, serial: '066DFF485457725187092834', devpath: '3.3.4.3.1' }],
          uarts: [{ index: 1, baudRate: 115200, devpath: '3.3.3.2' }],
          usbs: [{ index: 1 }],
          relays: [{ channel: 0, baseUrl: 'http://localhost:3000' }],
          power: { method: 'relay' }
        },
      remoteAddr: '127.0.0.1',
      clientVersion: version
    });
    clients.set(resourceId, { def, activity: { state: 'idle', jobId: null, since: Date.now() }, running: null });
  }

  const bootedAt = Date.now() - 3 * 86400000;
  function heartbeat(resourceId){
    const c = clients.get(resourceId),
      busy = Boolean(c.running);
    registry.heartbeat(resourceId, {
      state: busy ? 'busy' : 'idle',
      activeJobId: c.running,
      localLock: false,
      addresses: [{ iface: 'eth0', address: c.def.address, family: 'IPv4' }],
      remoteAddr: '127.0.0.1',
      clientVersion: version,
      hostUptimeSec: Math.round((Date.now() - bootedAt) / 1000),
      activity: { state: c.activity.state, jobId: c.activity.jobId, durationSec: Math.round((Date.now() - c.activity.since) / 1000) },
      rebootSchedule: registry.get(resourceId)?.reboot_schedule || null, // "applies" whatever is saved
      configRevision: registry.get(resourceId)?.config_revision || 0 // ...and any saved config
    });
    for (const command of services.commands.drain(resourceId)){
      if (command.command === 'scan-usb'){ // a plausible lsusb for the dashboard
        registry.storeUsbScan(resourceId, { requestId: command.requestId, output: VIRTUAL_LSUSB, error: null });
      }
    }
  }

  const beat = () => {
      for (const resourceId of clients.keys()){
        try {
          heartbeat(resourceId);
        }
        catch (err){
          console.error(`DEV virtual client heartbeat: ${err.message}`);
        }
      }
    },
    timer = setInterval(beat, intervalMs);
  timer.unref?.();
  beat();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    stillActive = (jobId) => ACTIVE_JOB_STATES.has(jobs.get(jobId)?.state);

  async function run(resourceId, jobId){
    const c = clients.get(resourceId);
    c.running = jobId;
    c.activity = { state: 'job', jobId, since: Date.now() };
    try {
      await sleep(800);
      if (!stillActive(jobId)){
        return;
      }
      jobs.setState(jobId, JOB_STATES.PREPARING);
      logs.appendBatch(jobId, [{ stream: 'runner', line: `(virtual client ${c.def.name}) preparing` }]);
      await sleep(1500);
      if (!stillActive(jobId)){
        return;
      }
      jobs.setState(jobId, JOB_STATES.RUNNING);
      for (const [stream, line]of LOG_SCRIPT){
        await sleep(600 + Math.random() * 900);
        if (!stillActive(jobId)){
          return; // canceled meanwhile
        }
        logs.appendBatch(jobId, [{ stream, line }]);
      }
      const failed = Math.random() < 0.2 ? 1 : 0;
      jobs.applyResult(jobId, resourceId, {
        state: failed ? JOB_STATES.FAILED : JOB_STATES.PASSED,
        exitCode: failed,
        summary: { total: 4, passed: 4 - failed, failed, skipped: 0 }
      });
    }
    catch (err){
      console.error(`DEV virtual client ${c.def.name}: ${err.message}`);
    }
    finally {
      c.running = null;
      c.activity = { state: 'idle', jobId: null, since: Date.now() };
      heartbeat(resourceId);
    }
  }

  bus.on('job.assigned', ({ jobId, resourceId }) => {
    if (clients.has(resourceId)){
      run(resourceId, jobId);
    }
  });

  return {
    resourceIds: Object.fromEntries([...clients].map(([id, c]) => [c.def.type, id])),
    stop: () => clearInterval(timer)
  };
}

// Entry point from server.js. Returns null outside DEV mode.
function startDevMode(services, config, env = process.env){
  if (!isDevMode(env)){
    return null;
  }
  const agentId = ensureAgent(services),
    virtual = startVirtualClients(services, config),
    seeded = seedHistory(services, agentId, virtual.resourceIds);
  // A few live ones for the virtual Clients to pick up right away.
  if (seeded){
    for (const [type, user]of [['sw', 'alice'], ['hw', null], ['sw', 'bob']]){
      services.jobs.create({ agentId, source: 'cli', spec: spec(type, user) });
    }
  }
  console.warn(
    '*** DEV MODE (DEV_MODE=1): virtual Clients virtual-sw-01 / virtual-hw-01 are running in-process' +
      `${seeded ? `, and ${seeded} past jobs + 3 live ones were seeded` : ''}.\n` +
      `*** Virtual agent token: ${DEV_AGENT_TOKEN}\n` +
      `***   e.g. thub --url ${config.publicUrl} --token ${DEV_AGENT_TOKEN} run --type sw --docker-image alpine --command 'uname -a'`
  );
  return virtual;
}

module.exports = { startDevMode, isDevMode, DEV_AGENT_TOKEN };
