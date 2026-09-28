/**
 * @file        packages/coordinator/public/js/confirm.js
 * @description Dashboard: confirmation modal for forms marked data-confirm (replaces the browser's confirm())
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

// A form with data-confirm="<message>" asks first, in the shared
// #thub-confirm-modal (layout.pug), and is only submitted on confirm.
// Optional: data-confirm-title, data-confirm-ok (confirm button label),
// data-confirm-tone (Bootstrap color: danger — the default —, warning,
// primary) and data-confirm-dismiss (the other button, default "Cancel").
// Texts are set as plain text, never HTML — they carry resource/group names.
(function (){
  const modalEl = document.getElementById('thub-confirm-modal');
  if (!modalEl){
    return;
  }
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl),
    field = (name) => modalEl.querySelector(`[data-field="${name}"]`),
    TONES = ['danger', 'warning', 'primary', 'secondary', 'success', 'info'];
  let pending = null; // { form, submitter } awaiting an answer

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm){
      return;
    }
    if (form.dataset.confirmed === '1'){
      delete form.dataset.confirmed; // one confirmation per submit
      return;
    }
    e.preventDefault();
    const tone = TONES.includes(form.dataset.confirmTone) ? form.dataset.confirmTone : 'danger';
    pending = { form, submitter: e.submitter };
    field('title').textContent = form.dataset.confirmTitle || 'Are you sure?';
    field('message').textContent = form.dataset.confirm;
    field('header').className = `modal-header text-bg-${tone}`;
    field('ok').className = `btn btn-${tone}`;
    field('ok').textContent = form.dataset.confirmOk || 'Confirm';
    field('dismiss').textContent = form.dataset.confirmDismiss || 'Cancel';
    modal.show();
  });

  field('ok').addEventListener('click', () => {
    if (!pending){
      return;
    }
    const { form, submitter } = pending;
    pending = null;
    form.dataset.confirmed = '1';
    modal.hide();
    // requestSubmit (not submit) so the form's own submit handlers still run.
    form.requestSubmit(submitter && form.contains(submitter) ? submitter : undefined);
  });

  modalEl.addEventListener('shown.bs.modal', () => field('ok').focus());
  modalEl.addEventListener('hidden.bs.modal', () => {
    pending = null;
  });
})();
