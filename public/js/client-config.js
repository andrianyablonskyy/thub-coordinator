/**
 * @file        packages/coordinator/public/js/client-config.js
 * @description Dashboard: the resource card's Capabilities form — add/remove device rows, and turn the form into
 *              an HW Client's hw-devices config section (JSON) on Save
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
  const val = (root, f) => root.querySelector(`[data-f="${f}"]`),
    text = (root, f) => (val(root, f)?.value || '').trim(),
    num = (root, f) => (text(root, f) === '' ? undefined : Number(text(root, f))),
    // Only set keys: an empty field means "not configured", not "".
    compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')),
    device = (value) => (/^\d+$/.test(value) ? { index: Number(value) } : { path: value });

  function rows(form, kind){
    return [...form.querySelectorAll(`[data-table="${kind}"] tbody [data-row]`)].map((tr) => {
      let extra = {};
      try {
        extra = JSON.parse(tr.dataset.extra || '{}');
      }
      catch {
        extra = {};
      }
      return compact({
        ...extra,
        ...device(text(tr, 'device')),
        baudRate: num(tr, 'baudRate'),
        devpath: text(tr, 'devpath')
      });
    });
  }

  // An HW Client's hw-devices section (the only Clients with a form).
  function sectionFrom(form){
    return {
      stlinks: rows(form, 'stlinks'),
      uarts: rows(form, 'uarts'),
      usbs: rows(form, 'usbs')
    };
  }

  // ⚠ on each config tab whose fields differ from what was loaded. A pane's
  // state: its field values (rows included) plus the hidden per-row extras.
  function paneState(pane){
    const fields = [...pane.querySelectorAll('input, select, textarea')].filter((i) => i.type !== 'hidden')
        .map((i) => (i.type === 'checkbox' ? i.checked : i.value)),
      extras = [...pane.querySelectorAll('tr[data-row]')].map((tr) => tr.dataset.extra || '');
    return JSON.stringify([fields, extras]);
  }

  document.querySelectorAll('[data-config-root]').forEach((root) => {
    const panes = [...root.querySelectorAll('[data-config-pane]')],
      loaded = new Map(panes.map((pane) => [pane, paneState(pane)]));
    function update(){
      for (const pane of panes){
        root.querySelector(`[data-config-tab="${pane.dataset.configPane}"] [data-dirty-icon]`)
          ?.classList.toggle('d-none', paneState(pane) === loaded.get(pane));
      }
    }
    for (const type of ['input', 'change', 'thub:changed']){
      root.addEventListener(type, update);
    }
  });

  document.querySelectorAll('form[data-client-config]').forEach((form) => {
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-row]'),
        remove = e.target.closest('[data-remove-row]');
      if (add){
        const kind = add.dataset.addRow,
          tbody = form.querySelector(`[data-table="${kind}"] tbody`);
        if (tbody.children.length >= 8){
          return; // the Client takes at most 8 of each
        }
        tbody.appendChild(form.querySelector(`template[data-template="${kind}"]`).content.cloneNode(true));
        form.dispatchEvent(new Event('thub:changed', { bubbles: true }));
      }
      else if (remove){
        remove.closest('tr').remove();
        form.dispatchEvent(new Event('thub:changed', { bubbles: true }));
      }
    });
    // Before confirm.js (capture phase), so the JSON is in place whatever
    // it decides; a bad number etc. is reported by the server on Save.
    form.addEventListener('submit', () => {
      form.querySelector('input[name="config"]').value = JSON.stringify(sectionFrom(form));
    }, true);
  });
})();
