/**
 * @file        packages/coordinator/public/js/update-watch.js
 * @description Dashboard: while a Coordinator self-update is pending, polls its status and reloads the page when done
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
  const marker = document.getElementById('coordinator-update-pending');
  if (!marker){
    return;
  }
  const currentVersion = marker.dataset.currentVersion,
    POLL_MS = 3000;

  // Reload once the Coordinator runs another version (the update is done),
  // or no longer has one pending (it failed — the reloaded page says why).
  // While it restarts, requests fail or hit the proxy's error page: keep
  // polling. A reply that isn't our JSON (e.g. the login page, sessions
  // having been reset by the restart) also means it's back — reload.
  async function poll(){
    let res;
    try {
      res = await fetch('/updates/status', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    }
    catch {
      return setTimeout(poll, POLL_MS); // down mid-restart
    }
    if (!res.ok){
      return setTimeout(poll, POLL_MS); // e.g. 502 from the reverse proxy
    }
    let status;
    try {
      status = await res.json();
    }
    catch {
      return location.reload();
    }
    if (status.coordinatorVersion !== currentVersion || !status.pending){
      return location.reload();
    }
    setTimeout(poll, POLL_MS);
  }

  setTimeout(poll, POLL_MS);
})();
