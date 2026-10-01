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
    GIVE_UP_MS = 60_000,
    REFRESH_TIP = 'Run lsusb -tvv on the Client now — it answers on its next heartbeat',
    WAITING_TIP = 'Waiting for the Client to run lsusb -tvv (its next heartbeat)',
    // The buttons are swapped by live updates (public/js/live.js), so
    // they're looked up when needed and clicks are handled at the document.
    timers = new WeakMap(),
    refreshButton = (pane) => pane.querySelector('[data-usb-refresh-wrap] button');

  // Enable or disable a button in its tooltip wrapper (which says why it's
  // disabled, or what it does).
  function setEnabled(wrap, on, tip){
    const button = wrap?.querySelector('button');
    if (!button){
      return;
    }
    button.disabled = !on;
    button.style.pointerEvents = on ? '' : 'none';
    wrap.tabIndex = on ? -1 : 0;
    if (tip && wrap.dataset.bsTitle !== tip){
      bootstrap.Tooltip.getInstance(wrap)?.dispose();
      wrap.dataset.bsTitle = tip;
    }
  }

  function show(pane, view){
    if (!view.scan){
      return;
    }
    const status = pane.querySelector('[data-usb-status]'),
      errorBox = pane.querySelector('[data-usb-error]'),
      output = pane.querySelector('[data-usb-output]'),
      importWrap = pane.querySelector('[data-usb-import-wrap]');
    status.textContent = `lsusb -tvv at ${view.scan.atText}`;
    errorBox.textContent = view.scan.error || '';
    errorBox.classList.toggle('d-none', !view.scan.error);
    output.textContent = view.scan.output || '';
    output.classList.toggle('d-none', !view.scan.output);
    if (importWrap?.dataset.tipEnabled){ // an HW Client that reports its config
      setEnabled(importWrap, Boolean(view.scan.output), view.scan.output ? importWrap.dataset.tipEnabled : null);
    }
  }

  function waiting(pane, on){
    const button = refreshButton(pane);
    if (button){
      setEnabled(button.parentElement, !on, on ? WAITING_TIP : REFRESH_TIP);
      button.querySelector('i').className = on ? 'spinner-border spinner-border-sm me-1' : 'bi bi-arrow-clockwise me-1';
    }
    if (on){
      pane.querySelector('[data-usb-status]').textContent = `${WAITING_TIP}…`;
    }
  }

  function poll(pane, requestedAt){
    clearTimeout(timers.get(pane));
    timers.set(pane, setTimeout(async () => {
      try {
        const view = await (await fetch(pane.dataset.usbScan, { cache: 'no-store', headers: { Accept: 'application/json' } })).json();
        if (!view.pending && view.scan && view.scan.at >= requestedAt){
          waiting(pane, false);
          return show(pane, view);
        }
      }
      catch {
        // network blip: keep polling
      }
      if (Date.now() - Date.parse(requestedAt) > GIVE_UP_MS){
        waiting(pane, false);
        pane.querySelector('[data-usb-status]').textContent = 'No answer from the Client — it may be too old to scan USB devices, or offline. Try again later.';
        return;
      }
      poll(pane, requestedAt);
    }, POLL_MS));
  }

  document.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-usb-refresh]'),
      pane = button?.closest('[data-usb-scan]');
    if (!pane || button.disabled){
      return;
    }
    waiting(pane, true);
    try {
      const res = await fetch(pane.dataset.usbScan, { method: 'POST', headers: { Accept: 'application/json' } }),
        view = await res.json();
      if (!res.ok){
        throw new Error(view.error || `HTTP ${res.status}`);
      }
      poll(pane, view.requestedAt);
    }
    catch (err){
      waiting(pane, false);
      pane.querySelector('[data-usb-status]').textContent = `Couldn't ask the Client: ${err.message}`;
    }
  });

  // A request still pending when the page loaded (e.g. after a reload).
  document.querySelectorAll('[data-usb-scan]').forEach((pane) => {
    if (pane.dataset.pending && pane.dataset.requestedAt){
      waiting(pane, true);
      poll(pane, pane.dataset.requestedAt);
    }
  });
})();
