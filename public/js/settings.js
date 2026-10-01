/**
 * @file        packages/coordinator/public/js/settings.js
 * @description Dashboard Settings page: generate/show the join key, and wait out a restart
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
  // Generate: a random key, shown so it can be copied into the Clients'
  // configs (joinKey) before saving.
  document.querySelectorAll('[data-secret-generate]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.querySelector(btn.dataset.secretGenerate),
        bytes = crypto.getRandomValues(new Uint8Array(32)),
        b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      input.value = `jk_${b64}`;
      input.type = 'text';
      input.select();
    });
  });
  document.querySelectorAll('[data-secret-show]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.querySelector(btn.dataset.secretShow);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Restarting: poll until a process with a different start time answers,
  // then reload (riding out the seconds it's down).
  const banner = document.querySelector('[data-restarting]');
  if (banner){
    const before = banner.dataset.restarting,
      started = Date.now(),
      poll = async () => {
        try {
          const res = await fetch('/admin/settings/status', { cache: 'no-store', redirect: 'manual' });
          if (res.type === 'opaqueredirect'){
            window.location.href = '/login'; // the session didn't survive? sign in again
            return;
          }
          if (res.ok && (await res.json()).startedAt !== before){
            window.location.href = '/admin/settings';
            return;
          }
        }
        catch {
          // down for now
        }
        if (Date.now() - started > 120_000){
          banner.lastElementChild.textContent = 'The Coordinator hasn\'t come back after 2 minutes — check journalctl -u thub-coordinator on its host.';
          banner.querySelector('.spinner-border')?.remove();
          return;
        }
        setTimeout(poll, 1500);
      };
    setTimeout(poll, 1500);
  }
})();
