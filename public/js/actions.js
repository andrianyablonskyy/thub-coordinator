/**
 * @file        packages/coordinator/public/js/actions.js
 * @description Dashboard: small declarative behaviours (data-* attributes) that used to be inline on*= handlers
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

// The Content-Security-Policy (server.js) allows no inline script, so no
// onclick=/onchange=/onsubmit= in the templates: they declare what they
// want with these attributes instead. Delegated, so it also works for
// content swapped in by live updates (live.js).
(function (){
  // <select data-navigate>: its option values are URLs to go to.
  // <select data-autosubmit>: submit its form on change.
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches?.('select[data-navigate]')){
      window.location.href = el.value;
    }
    else if (el.matches?.('[data-autosubmit]') && el.form){
      el.form.submit();
    }
  });

  // <button data-fill="#field" data-value="…">: put the value into #field.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fill]'),
      target = btn && document.querySelector(btn.dataset.fill);
    if (target){
      target.value = btn.dataset.value;
    }
  });

  // The collapsed (mobile) menu drops down over the page (thub.css
  // .thub-nav): close it on a tap outside, on Esc, and once a page in it is
  // chosen — over the content, it shouldn't stay open in the way.
  const nav = document.getElementById('nav'),
    closeNav = () => {
      if (nav?.classList.contains('show')){
        window.bootstrap?.Collapse.getOrCreateInstance(nav, { toggle: false }).hide();
      }
    };
  document.addEventListener('click', (e) => {
    if (!nav?.classList.contains('show')){
      return;
    }
    if (!e.target.closest('#nav, .navbar-toggler') || e.target.closest('#nav a[href]')){
      closeNav();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape'){
      closeNav();
    }
  });

  // <form data-submit-busy>: disable its button and show a spinner while
  // the request runs (e.g. the navbar's check for updates).
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.matches?.('form[data-submit-busy]') || e.defaultPrevented){
      return;
    }
    const button = form.querySelector('button'),
      icon = button?.querySelector('i');
    if (button){
      button.disabled = true;
    }
    if (icon){
      icon.className = 'spinner-border spinner-border-sm';
    }
  });
})();
