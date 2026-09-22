/**
 * @file        packages/coordinator/public/js/theme.js
 * @description Dashboard: light/dark theme toggle, persisted in localStorage
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

(function () {
  const root = document.documentElement;
  const key = 'thub-theme';

  function apply(theme) {
    root.setAttribute('data-bs-theme', theme);
  }

  const stored = localStorage.getItem(key);
  if (stored) apply(stored);

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    localStorage.setItem(key, next);
  });
})();
