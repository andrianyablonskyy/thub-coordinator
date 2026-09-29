/**
 * @file        packages/coordinator/public/js/usb-parse.js
 * @description Parses `lsusb -tvv` output into USB devices and sorts the ones a HW Client can use into its config
 *              lists (ST-Links, UARTs, DUT USB) — for "Import to config" on the resource card; also loadable in Node
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

(function (root){
  // vendor:product -> the Client config list it belongs in. The first id of
  // each list is the Client's own default (udev.js), which needs no
  // vendorId/productId on the row.
  const KNOWN = {
      '0483:3748': { kind: 'stlinks', label: 'ST-Link/V2' },
      '0483:374b': { kind: 'stlinks', label: 'ST-Link/V2-1' },
      '0483:374e': { kind: 'stlinks', label: 'STLINK-V3' },
      '0483:374f': { kind: 'stlinks', label: 'STLINK-V3' },
      '0483:3753': { kind: 'stlinks', label: 'STLINK-V3' },
      '0483:3754': { kind: 'stlinks', label: 'STLINK-V3' },
      '0403:6001': { kind: 'uarts', label: 'FTDI FT232R' },
      '0403:6015': { kind: 'uarts', label: 'FTDI FT-X' },
      '0403:6010': { kind: 'uarts', label: 'FTDI FT2232' },
      '0403:6014': { kind: 'uarts', label: 'FTDI FT232H' },
      '10c4:ea60': { kind: 'uarts', label: 'Silicon Labs CP210x' },
      '1a86:7523': { kind: 'uarts', label: 'CH340' },
      '067b:2303': { kind: 'uarts', label: 'Prolific PL2303' },
      '0483:5740': { kind: 'usbs', label: 'STM32 Virtual COM Port (DUT USB)' }
    },
    DEFAULT_IDS = { stlinks: '0483:3748', uarts: '0403:6001', usbs: '0483:5740' },
    MAX_PER_KIND = 8;

  // Devices from `lsusb -tvv`: one per /sys path (interfaces of the same
  // device repeat it), root hubs included, each as
  // { id, vendorId, productId, name, driver, sysPath, devpath }. `devpath`
  // is what udev calls ATTR{devpath}: the port path after "<bus>-".
  function parseLsusbTree(text){
    const devices = new Map();
    let current = null;
    for (const line of String(text || '').split('\n')){
      if (/^\s*(\/:|\|__)\s/.test(line)){
        current = { driver: (/Driver=([^,]*)/.exec(line) || [])[1] || '' };
        continue;
      }
      if (!current){
        continue;
      }
      const id = /^\s*ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/.exec(line);
      if (id){
        Object.assign(current, { vendorId: id[1].toLowerCase(), productId: id[2].toLowerCase(), name: id[3].trim() });
        current.id = `${current.vendorId}:${current.productId}`;
        continue;
      }
      const sys = /\/sys\/bus\/usb\/devices\/([^\s]+)/.exec(line);
      if (sys && current.id){
        const sysPath = sys[1],
          port = /^\d+-([\d.]+)$/.exec(sysPath);
        if (!devices.has(sysPath)){
          devices.set(sysPath, { ...current, sysPath, devpath: port ? port[1] : null });
        }
        current = null;
      }
    }
    return [...devices.values()];
  }

  // { lists: { stlinks, uarts, usbs }, skipped } — the devices a HW Client
  // can use, in port order, each { devpath, id, label, name, driver,
  // vendorId?, productId? } (ids only when not the list's default), at most
  // 8 per list (the rest skipped too).
  function classifyDevices(devices){
    const lists = { stlinks: [], uarts: [], usbs: [] },
      skipped = [],
      byPort = [...devices].sort((a, b) => (a.devpath || '').localeCompare(b.devpath || '', undefined, { numeric: true }));
    for (const d of byPort){
      const known = KNOWN[d.id];
      if (!d.devpath){
        skipped.push({ ...d, reason: 'root hub' });
      }
      else if (!known){
        skipped.push({ ...d, reason: /hub/i.test(d.name) || d.driver.startsWith('hub') ? 'hub' : 'not a device the Client uses' });
      }
      else if (lists[known.kind].length >= MAX_PER_KIND){
        skipped.push({ ...d, reason: `more than ${MAX_PER_KIND} ${known.kind}` });
      }
      else {
        lists[known.kind].push({
          devpath: d.devpath,
          id: d.id,
          label: known.label,
          name: d.name,
          driver: d.driver,
          ...(d.id === DEFAULT_IDS[known.kind] ? {} : { vendorId: d.vendorId, productId: d.productId })
        });
      }
    }
    return { lists, skipped };
  }

  const api = { parseLsusbTree, classifyDevices, KNOWN_USB_DEVICES: KNOWN };
  if (typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  else {
    root.thubUsbParse = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
