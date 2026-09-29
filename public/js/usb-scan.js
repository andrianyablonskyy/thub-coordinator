/**
 * @file        packages/coordinator/public/js/usb-scan.js
 * @description Dashboard: the resource card's "Connected USB devices" tab — Refresh asks the Client for `lsusb`,
 *              then polls until its answer arrives and shows it in place
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
  const POLL_MS = 2000,
    // The Client answers on its next heartbeat (10 s by default); no answer
    // by then means it's too old to know scan-usb, or went away.
    GIVE_UP_MS = 60_000;

  document.querySelectorAll('[data-usb-scan]').forEach((pane) => {
    const url = pane.dataset.usbScan,
      button = pane.querySelector('[data-usb-refresh]'),
      status = pane.querySelector('[data-usb-status]'),
      errorBox = pane.querySelector('[data-usb-error]'),
      output = pane.querySelector('[data-usb-output]');
    let timer = null;

    function show(view){
      if (view.scan){
        status.textContent = `lsusb -tvv at ${view.scan.atText}`;
        errorBox.textContent = view.scan.error || '';
        errorBox.classList.toggle('d-none', !view.scan.error);
        output.textContent = view.scan.output || '';
        output.classList.toggle('d-none', !view.scan.output);
        const importButton = pane.querySelector('[data-usb-import]');
        if (importButton){
          importButton.disabled = !view.scan.output;
        }
      }
    }

    function waiting(on){
      if (button){
        button.disabled = on;
        button.querySelector('i').className = on ? 'spinner-border spinner-border-sm me-1' : 'bi bi-arrow-clockwise me-1';
      }
      if (on){
        status.textContent = 'Waiting for the Client to run lsusb -tvv (its next heartbeat)…';
      }
    }

    function poll(requestedAt){
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const view = await (await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })).json();
          if (!view.pending && view.scan && view.scan.at >= requestedAt){
            waiting(false);
            return show(view);
          }
        }
        catch {
          // network blip: keep polling
        }
        if (Date.now() - Date.parse(requestedAt) > GIVE_UP_MS){
          waiting(false);
          status.textContent = 'No answer from the Client — it may be too old to scan USB devices, or offline. Try again later.';
          return;
        }
        poll(requestedAt);
      }, POLL_MS);
    }

    button?.addEventListener('click', async () => {
      waiting(true);
      try {
        const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } }),
          view = await res.json();
        if (!res.ok){
          throw new Error(view.error || `HTTP ${res.status}`);
        }
        poll(view.requestedAt);
      }
      catch (err){
        waiting(false);
        status.textContent = `Couldn't ask the Client: ${err.message}`;
      }
    });

    // A request still pending when the page loaded (e.g. after a reload).
    if (pane.dataset.pending && pane.dataset.requestedAt){
      waiting(true);
      poll(pane.dataset.requestedAt);
    }
  });
})();
