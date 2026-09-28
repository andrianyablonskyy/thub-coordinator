/**
 * @file        packages/coordinator/public/js/remove-resource.js
 * @description Dashboard: warning modal for removing a resource that is running a job (stop job, then remove)
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
  const modalEl = document.getElementById('remove-resource-modal');
  if (!modalEl){
    return;
  }
  const field = (name) => modalEl.querySelector(`[data-field="${name}"]`);

  document.querySelectorAll('[data-remove-resource]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { removeResource: id, removeName: name, removeJob: job, removeReturn: returnTo } = btn.dataset;
      field('name').textContent = name;
      field('job').textContent = job;
      field('job').href = `/jobs/${encodeURIComponent(job)}`;
      field('job-text').textContent = job;
      field('form').action = `/resources/${encodeURIComponent(id)}/remove`;
      field('return').value = returnTo || '/resources';

      // Clicked from inside a resource card: close that first — Bootstrap
      // doesn't stack modals.
      const card = btn.closest('.modal');
      if (card){
        card.addEventListener('hidden.bs.modal', () => bootstrap.Modal.getOrCreateInstance(modalEl).show(), { once: true });
        bootstrap.Modal.getInstance(card)?.hide();
      }
      else {
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
      }
    });
  });
})();
