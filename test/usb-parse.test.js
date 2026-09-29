/**
 * @file        packages/coordinator/test/usb-parse.test.js
 * @description Tests: parsing `lsusb -tvv` and sorting devices into a HW Client's config lists ("Import to config")
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
  { parseLsusbTree, classifyDevices } = require('../public/js/usb-parse');

const LSUSB = `/:  Bus 001.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/12p, 480M
    ID 1d6b:0002 Linux Foundation 2.0 root hub
    /sys/bus/usb/devices/usb1  /dev/bus/usb/001/001
    |__ Port 003: Dev 002, If 0, Class=Hub, Driver=hub/4p, 480M
        ID 05e3:0610 Genesys Logic, Inc. Hub
        /sys/bus/usb/devices/1-3  /dev/bus/usb/001/002
        |__ Port 010: Dev 009, If 0, Class=Vendor Specific Class, Driver=, 12M
            ID 0483:3748 STMicroelectronics ST-LINK/V2
            /sys/bus/usb/devices/1-3.10  /dev/bus/usb/001/009
        |__ Port 002: Dev 005, If 0, Class=Vendor Specific Class, Driver=ftdi_sio, 12M
            ID 0403:6001 Future Technology Devices International, Ltd FT232 Serial (UART) IC
            /sys/bus/usb/devices/1-3.2  /dev/bus/usb/001/005
        |__ Port 001: Dev 004, If 0, Class=Vendor Specific Class, Driver=, 12M
            ID 0483:374b STMicroelectronics ST-LINK/V2.1
            /sys/bus/usb/devices/1-3.1  /dev/bus/usb/001/004
        |__ Port 001: Dev 004, If 1, Class=Mass Storage, Driver=usb-storage, 12M
            ID 0483:374b STMicroelectronics ST-LINK/V2.1
            /sys/bus/usb/devices/1-3.1  /dev/bus/usb/001/004
        |__ Port 004: Dev 007, If 0, Class=Vendor Specific Class, Driver=ch341, 12M
            ID 1a86:7523 QinHeng Electronics CH340 serial converter
            /sys/bus/usb/devices/1-3.4  /dev/bus/usb/001/007
    |__ Port 005: Dev 003, If 0, Class=Communications, Driver=cdc_acm, 12M
        ID 0483:5740 STMicroelectronics Virtual COM Port
        /sys/bus/usb/devices/1-5  /dev/bus/usb/001/003
    |__ Port 006: Dev 008, If 0, Class=Human Interface Device, Driver=usbhid, 1.5M
        ID 046d:c077 Logitech, Inc. Mouse
        /sys/bus/usb/devices/1-6  /dev/bus/usb/001/008`;

test('parses every device once, with its ids, name, driver and udev devpath', () => {
  const devices = parseLsusbTree(LSUSB);
  assert.equal(devices.length, 8); // the ST-Link/V2-1's two interfaces are one device
  const ftdi = devices.find((d) => d.id === '0403:6001');
  assert.deepEqual([ftdi.devpath, ftdi.driver, ftdi.sysPath], ['3.2', 'ftdi_sio', '1-3.2']);
  assert.equal(devices.find((d) => d.sysPath === 'usb1').devpath, null);
  assert.deepEqual(parseLsusbTree(''), []);
});

test('sorts devices into the Client\'s lists in port order, with ids only when not the default', () => {
  const { lists, skipped } = classifyDevices(parseLsusbTree(LSUSB));
  assert.deepEqual(lists.stlinks.map((d) => [d.devpath, d.vendorId, d.productId]), [['3.1', '0483', '374b'], ['3.10', undefined, undefined]]);
  assert.deepEqual(lists.uarts.map((d) => [d.devpath, d.id, d.vendorId]), [['3.2', '0403:6001', undefined], ['3.4', '1a86:7523', '1a86']]);
  assert.deepEqual(lists.usbs.map((d) => d.devpath), ['5']);
  assert.deepEqual(skipped.map((d) => [d.id, d.reason]), [
    ['1d6b:0002', 'root hub'], ['05e3:0610', 'hub'], ['046d:c077', 'not a device the Client uses']
  ]);
});

test('at most 8 per list; the rest are skipped', () => {
  const ftdi = { id: '0403:6001', vendorId: '0403', productId: '6001', name: 'FT232', driver: 'ftdi_sio' },
    many = Array.from({ length: 10 }, (_, i) => ({ ...ftdi, devpath: `2.${i + 1}` })),
    { lists, skipped } = classifyDevices(many);
  assert.equal(lists.uarts.length, 8);
  assert.deepEqual(skipped.map((d) => d.reason), ['more than 8 uarts', 'more than 8 uarts']);
});
