/**
 * @file        packages/coordinator/public/js/list-search.js
 * @description Dashboard list search (views/mixins/list-controls.pug +searchBox): "/" focuses it, Esc clears it
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
  const input = document.querySelector('[data-list-search]');
  if (!input){
    return;
  }

  // "/" anywhere outside a text field jumps to the search box (as on GitHub).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey){
      return;
    }
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)){
      return;
    }
    e.preventDefault();
    input.focus();
    input.select();
  });

  // Esc: empty the box; if the page is showing search results, go back to
  // the full list (the Clear link keeps the page's other filters).
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape'){
      return;
    }
    const clear = input.closest('.thub-search')?.querySelector('[data-list-search-clear]');
    if (clear){
      window.location.href = clear.href;
    }
    else {
      input.value = '';
      input.blur();
    }
  });
})();
