/**
 * @file        packages/coordinator/public/js/toasts.js
 * @description Dashboard: shows flash messages as Bootstrap toasts that close themselves by severity
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
  // Auto-close delay per severity; null = stays until closed. Errors never
  // close on their own, and neither does a toast marked sticky (e.g. a
  // one-time token the user still has to copy).
  const DELAY_MS = { danger: null, warning: 30_000, info: 10_000, success: 10_000 };

  document.querySelectorAll('[data-thub-toast]').forEach((el) => {
    const type = el.dataset.thubToast in DELAY_MS ? el.dataset.thubToast : 'info',
      delay = el.dataset.sticky ? null : DELAY_MS[type],
      toast = new bootstrap.Toast(el, { autohide: delay !== null, delay: delay ?? 0 });
    // "Self-destroying": gone from the page once hidden, not just invisible.
    el.addEventListener('hidden.bs.toast', () => {
      toast.dispose();
      el.remove();
    });
    toast.show();
  });
})();
