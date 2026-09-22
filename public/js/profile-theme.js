/**
 * @file        packages/coordinator/public/js/profile-theme.js
 * @description Profile page: wires the auto/light/dark buttons to the shared theme setter (theme.js)
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
  const buttons = document.querySelectorAll('[data-set-theme]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.setTheme;
      window.thubSetTheme(theme);
      buttons.forEach((b) => {
        b.classList.toggle('btn-primary', b === btn);
        b.classList.toggle('btn-outline-secondary', b !== btn);
      });
    });
  });
})();
