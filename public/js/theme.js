/**
 * @file        packages/coordinator/public/js/theme.js
 * @description Dashboard: theme toggle, persisted to the account (§10.1) with localStorage as a pre-login fallback
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
  const root = document.documentElement,
    key = 'thub-theme';

  function apply(theme){
    root.setAttribute('data-bs-theme', theme);
  }

  // Server-rendered value (layout.pug: html(data-bs-theme=user.theme)) wins
  // once logged in — it's the account's saved preference, synced across
  // devices (§10.1). "auto" means no account preference yet (or logged
  // out, e.g. the login page), so localStorage is still the fallback there.
  if (root.getAttribute('data-bs-theme') === 'auto'){
    const stored = localStorage.getItem(key);
    if (stored){
      apply(stored);
    }
  }

  // Shared by the navbar toggle below and the profile page's theme buttons
  // (public/js/profile-theme.js) — one place that applies it locally and
  // persists it to the account, so both call sites can't drift.
  window.thubSetTheme = function thubSetTheme(theme){
    apply(theme);
    localStorage.setItem(key, theme);
    fetch('/profile/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    }).catch(() => {}); // best effort — logged-out visitors can still toggle locally
  };

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    window.thubSetTheme(root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark');
  });
})();
