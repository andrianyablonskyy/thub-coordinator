/**
 * @file        packages/coordinator/public/js/resource-card.js
 * @description Dashboard: opens a resource's info card (modal) when its row/card is clicked or activated by keyboard
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
  function open(el){
    const modal = document.getElementById(el.dataset.resourceCard);
    if (modal){
      bootstrap.Modal.getOrCreateInstance(modal).show();
    }
  }

  // Delegated, so rows and cards swapped in by live updates (live.js) work.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-resource-card]');
    // The Resources table's own action buttons stay plain actions.
    if (el && !e.target.closest('form, button, a, input')){
      open(el);
    }
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('[data-resource-card]');
    if (el && (e.key === 'Enter' || e.key === ' ') && e.target === el){
      e.preventDefault();
      open(el);
    }
  });
})();
