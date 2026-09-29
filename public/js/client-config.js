/**
 * @file        packages/coordinator/public/js/client-config.js
 * @description Dashboard: the resource card's Capabilities form — add/remove device rows, and turn the form into
 *              the Client's hw/sw config section (JSON) on Save
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
      if (kind === 'relays'){
        return compact({ channel: num(tr, 'channel'), baseUrl: text(tr, 'baseUrl') });
      }
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
        serial: text(tr, 'serial'),
        baudRate: num(tr, 'baudRate'),
        devpath: text(tr, 'devpath')
      });
    });
  }

  function sectionFrom(form){
    if (form.dataset.clientConfig === 'sw'){
      return compact({
        image: text(form, 'image'),
        registry: text(form, 'registry'),
        cpus: num(form, 'cpus'),
        memory: text(form, 'memory'),
        cmd: text(form, 'cmd') ? text(form, 'cmd').split(/\s+/) : undefined,
        allowDockerHub: val(form, 'allowDockerHub').checked,
        allowJobImages: val(form, 'allowJobImages').checked
      });
    }
    const power = form.querySelector('[data-power]'),
      method = text(power, 'method');
    return {
      stlinks: rows(form, 'stlinks'),
      uarts: rows(form, 'uarts'),
      usbs: rows(form, 'usbs'),
      relays: rows(form, 'relays'),
      power: method ? compact({ method, hub: text(power, 'hub'), port: num(power, 'port'), baseUrl: text(power, 'baseUrl') }) : null
    };
  }

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
      }
      else if (remove){
        remove.closest('tr').remove();
      }
    });
    // Before confirm.js (capture phase), so the JSON is in place whatever
    // it decides; a bad number etc. is reported by the server on Save.
    form.addEventListener('submit', () => {
      form.querySelector('input[name="config"]').value = JSON.stringify(sectionFrom(form));
    }, true);
  });
})();
