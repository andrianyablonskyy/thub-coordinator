/**
 * @file        packages/coordinator/public/js/help.js
 * @description Dashboard Help page: copy buttons on code blocks, table-of-contents scrollspy, section filter
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
  // Copy button on every code block (views/help/_mixins.pug +code). Copies
  // the decoded text, so `&lt;` placeholders come out as `<`.
  document.querySelectorAll('.thub-code').forEach((figure) => {
    const code = figure.querySelector('code');
    if (!code){
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline-secondary thub-code-copy';
    btn.setAttribute('aria-label', 'Copy to clipboard');
    btn.title = 'Copy to clipboard';
    btn.innerHTML = '<i class="bi bi-clipboard"></i>';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
      }
      catch {
        return; // clipboard unavailable (e.g. non-secure context) — fail quietly
      }
      const icon = btn.querySelector('i');
      icon.className = 'bi bi-check2';
      setTimeout(() => {
        icon.className = 'bi bi-clipboard';
      }, 1200);
    });
    figure.appendChild(btn);
  });

  // Highlight the table-of-contents entry of the section in view.
  if (window.bootstrap && document.getElementById('help-toc')){
    new window.bootstrap.ScrollSpy(document.body, { target: '#help-toc', rootMargin: '0px 0px -60%' });
  }

  // Small screens: the jump menu replaces the sidebar.
  const jump = document.getElementById('help-jump');
  if (jump){
    jump.addEventListener('change', () => {
      document.getElementById(jump.value)?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Filter: hide sections (and their TOC entries) that don't contain every
  // word typed. Both filter boxes (sidebar, small screens) stay in sync.
  const sections = [...document.querySelectorAll('[data-help-section]')],
    inputs = ['help-filter', 'help-filter-sm'].map((id) => document.getElementById(id)).filter(Boolean),
    noMatch = document.getElementById('help-no-match'),
    texts = new Map(sections.map((s) => [s, s.textContent.toLowerCase()]));

  function applyFilter(value){
    const words = value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const section of sections){
      const match = words.every((w) => texts.get(section).includes(w));
      section.hidden = !match;
      shown += match ? 1 : 0;
      const tocLink = document.querySelector(`[data-help-toc="${section.id}"]`);
      if (tocLink){
        tocLink.hidden = !match;
      }
    }
    if (noMatch){
      noMatch.hidden = shown > 0;
    }
  }

  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      inputs.forEach((other) => {
        if (other !== input){
          other.value = input.value;
        }
      });
      applyFilter(input.value);
    });
  });
})();
