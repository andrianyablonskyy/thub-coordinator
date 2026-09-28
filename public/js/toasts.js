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
      // Our own countdown instead of Bootstrap's autohide: that one restarts
      // the full delay after every hover, which a progress bar can't show.
      toast = new bootstrap.Toast(el, { autohide: false });
    // "Self-destroying": gone from the page once hidden, not just invisible.
    el.addEventListener('hidden.bs.toast', () => {
      toast.dispose();
      el.remove();
    });

    // The bar is the timer: a CSS animation over `delay` (paused while the
    // toast is hovered or focused, see thub.css) — the toast closes when
    // it ends. Added here, not in the markup, so without this script no
    // bar suggests a close that would never happen.
    if (delay !== null){
      const bar = document.createElement('div');
      bar.className = 'thub-toast-progress';
      bar.setAttribute('aria-hidden', 'true');
      bar.style.setProperty('--thub-toast-delay', `${delay}ms`);
      bar.addEventListener('animationend', () => toast.hide(), { once: true });
      el.classList.add('position-relative', 'overflow-hidden');
      el.appendChild(bar);
    }
    toast.show();
  });
})();
