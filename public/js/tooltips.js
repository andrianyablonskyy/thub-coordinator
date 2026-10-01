/**
 * @file        packages/coordinator/public/js/tooltips.js
 * @description Dashboard: initializes Bootstrap tooltips on data-bs-toggle elements
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

// Delegated (one instance per element, created on first hover/focus), so
// content swapped in by live updates (public/js/live.js) gets tooltips too.
(function (){
  // On touch screens a tap would open a tooltip and leave it stuck there
  // (no hover to end it) — over the mobile menu, too: no tooltips there.
  if (!window.matchMedia('(hover: hover)').matches){
    return;
  }
  new bootstrap.Tooltip(document.body, { selector: '[data-bs-toggle="tooltip"]' });
})();
