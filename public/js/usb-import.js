/**
 * @file        packages/coordinator/public/js/usb-import.js
 * @description Dashboard: "Import to config" on the resource card's USB devices tab — updates the Config
 *              sub-tabs' device lists from the last `lsusb -tvv`, opens the first changed one, and asks to verify
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

(function (){
  const { parseLsusbTree, classifyDevices } = window.thubUsbParse,
    TITLES = { stlinks: 'ST-Link', uarts: 'UART', usbs: 'DUT USB' },
    MAX_INDEX = 8,

    el = (tag, attrs = {}, ...children) => {
      const node = document.createElement(tag);
      for (const [k, v]of Object.entries(attrs)){
        if (k === 'class'){
          node.className = v;
        }
        else {
          node.setAttribute(k, v);
        }
      }
      for (const c of children){
        node.append(c);
      }
      return node;
    };

  // Updates one device table from the scan, keeping what's stable:
  //   - a row already there for a scanned port (same udev devpath) keeps its
  //     Device — so its /dev/thub/dut<N>-… symlink, and anything using it,
  //     don't move — and what the scan can't know (serial, baud rate, extras);
  //   - a newly found device gets the lowest free udev index;
  //   - a row with no devpath (an explicit /dev path set by hand) stays;
  //   - a row for a port that's not in the scan any more is removed.
  // Returns { rows: [{ devpath, device, isNew, label, id }], removed: [ports] }.
  function fillTable(form, kind, devices){
    const tbody = form.querySelector(`[data-table="${kind}"] tbody`),
      template = form.querySelector(`template[data-template="${kind}"]`),
      rows = [...tbody.querySelectorAll('tr')].map((tr) => ({
        tr,
        devpath: tr.querySelector('[data-f="devpath"]')?.value.trim() || '',
        device: tr.querySelector('[data-f="device"]')?.value.trim() || ''
      })),
      byPort = new Map(rows.filter((r) => r.devpath).map((r) => [r.devpath, r])),
      manual = rows.filter((r) => !r.devpath),
      scanned = new Set(devices.map((d) => d.devpath)),
      used = new Set([...manual, ...rows.filter((r) => scanned.has(r.devpath))].map((r) => r.device)),
      nextIndex = () => {
        for (let i = 1; i <= MAX_INDEX; i++){
          if (!used.has(String(i))){
            used.add(String(i));
            return String(i);
          }
        }
        return '';
      },
      result = [],

      updated = devices.map((d) => {
        const old = byPort.get(d.devpath),
          tr = old ? old.tr : template.content.firstElementChild.cloneNode(true);
        let extra = {};
        try {
          extra = JSON.parse(tr.dataset.extra || '{}');
        }
        catch {
          extra = {};
        }
        delete extra.vendorId;
        delete extra.productId;
        if (d.vendorId){
          Object.assign(extra, { vendorId: d.vendorId, productId: d.productId });
        }
        tr.dataset.extra = JSON.stringify(extra);
        const device = old ? old.device : nextIndex();
        tr.querySelector('[data-f="device"]').value = device;
        tr.querySelector('[data-f="devpath"]').value = d.devpath;
        result.push({ devpath: d.devpath, device, isNew: !old, label: d.label, id: d.id });
        return tr;
      });
    tbody.replaceChildren(...updated, ...manual.map((r) => r.tr));
    return { rows: result, removed: rows.filter((r) => r.devpath && !scanned.has(r.devpath)).map((r) => r.devpath) };
  }

  function overlay(modal, { total, skipped, changes }){
    const content = modal.querySelector('.modal-content'),
      body = el('div', { class: 'card-body small' });
    body.append(el('p', {}, total
      ? 'The ST-Link, UART and DUT USB tabs were updated from the last lsusb -tvv scan (⚠ marks what changed). Nothing is saved yet: ' +
        'check them, set what the scan can\'t know (e.g. UART baud rates), then press Save capabilities.'
      : 'The scan has no device a HW Client uses (ST-Link, USB-serial adapter, STM32 COM port), so nothing was changed.'));
    for (const [kind, change]of Object.entries(changes)){
      if (!change.rows.length && !change.removed.length){
        continue;
      }
      body.append(el('strong', {}, `${TITLES[kind]} (${change.rows.length})`));
      body.append(el('ul', { class: 'mb-2' },
        ...change.rows.map((row) => el('li', {}, `Device ${row.device || '?'} ← port `, el('code', {}, row.devpath), ` ${row.label} (${row.id}) `,
          el('span', { class: `badge ${row.isNew ? 'text-bg-primary' : 'text-bg-secondary'}` }, row.isNew ? 'new' : 'already configured'))),
        ...change.removed.map((port) => el('li', { class: 'text-warning-emphasis' }, 'Removed: port ', el('code', {}, port), ' — not in the scan'))));
    }
    if (changes.stlinks?.rows.length){
      body.append(el('p', { class: 'text-body-secondary mb-2' },
        'ST-Link serials aren\'t in lsusb -tvv: the Client looks them up from each probe\'s udev symlink.'));
    }
    if (skipped.length){
      body.append(el('details', {}, el('summary', {}, `Not imported (${skipped.length})`),
        el('ul', { class: 'mb-0' }, ...skipped.map((d) =>
          el('li', {}, `${d.name || d.id} (${d.id}${d.devpath ? `, port ${d.devpath}` : ''}) — ${d.reason}`)))));
    }
    const close = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, total ? 'Review configuration' : 'OK'),
      card = el('div', { class: 'card shadow', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'thub-import-title' },
        el('div', { class: 'card-header fw-semibold', id: 'thub-import-title' }, total ? 'Verify the imported configuration' : 'Nothing to import'),
        body,
        el('div', { class: 'card-footer text-end' }, close)),
      layer = el('div', { class: 'thub-overlay' }, card);
    content.style.position = 'relative';
    content.appendChild(layer);
    // Esc closes the note, not the whole resource card behind it.
    const onKey = (e) => {
        if (e.key === 'Escape'){
          e.stopPropagation();
          e.preventDefault();
          dismiss();
        }
      },
      dismiss = () => {
        layer.remove();
        modal.removeEventListener('keydown', onKey, true);
      };
    modal.addEventListener('keydown', onKey, true);
    close.addEventListener('click', dismiss);
    modal.addEventListener('hidden.bs.modal', dismiss, { once: true });
    close.focus();
  }

  // At the document: the button is swapped by live updates (public/js/live.js).
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-usb-import]');
    if (button && !button.disabled){
      const pane = button.closest('[data-usb-scan]'),
        modal = button.closest('.modal'),
        form = modal.querySelector('form[data-client-config="hw"]');
      if (!form){
        return;
      }
      const { lists, skipped } = classifyDevices(parseLsusbTree(pane.querySelector('[data-usb-output]').textContent)),
        total = Object.values(lists).reduce((n, l) => n + l.length, 0),
        changes = total ? Object.fromEntries(Object.entries(lists).map(([kind, devices]) => [kind, fillTable(form, kind, devices)])) : {};
      if (total){
        form.dispatchEvent(new Event('thub:changed', { bubbles: true })); // ⚠ on what changed
        // Open the first config tab the import changed (else ST-Link).
        const root = form.closest('[data-config-root]'),
          changed = ['stlinks', 'uarts', 'usbs'].find((k) =>
            !root.querySelector(`[data-config-tab="${k}"] [data-dirty-icon]`).classList.contains('d-none')) || 'stlinks';
        bootstrap.Tab.getOrCreateInstance(root.querySelector(`[data-config-tab="${changed}"]`)).show();
      }
      overlay(modal, { total, skipped, changes });
    }
  });
})();
