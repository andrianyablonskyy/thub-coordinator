/**
 * @file        packages/coordinator/public/js/copy-to-clipboard.js
 * @description Dashboard: copies an element's data-copy value to the clipboard on click
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
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
      } catch {
        return; // clipboard unavailable (e.g. non-secure context) — fail quietly
      }
      const icon = btn.querySelector('i');
      if (!icon) return;
      const original = icon.className;
      icon.className = 'bi bi-check2';
      setTimeout(() => {
        icon.className = original;
      }, 1200);
    });
  });
})();
