/**
 * @file        packages/coordinator/public/js/config-import.js
 * @description Dashboard: the resource card's config Import button — picks a JSON file, puts it in the import form
 *              and submits it, confirmed first (confirm.js) with what will and won't be applied
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
  const IGNORED = ['joinKey', 'coordinatorUrl', 'name'],
    MAX_BYTES = 64 * 1024;

  document.querySelectorAll('form[data-config-import]').forEach((form) => {
    const picker = form.querySelector('[data-config-import-file]');
    form.querySelector('[data-config-import-pick]').addEventListener('click', () => {
      picker.value = ''; // the same file again still fires `change`
      picker.click();
    });

    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file){
        return;
      }
      const text = file.size > MAX_BYTES ? '' : await file.text();
      form.querySelector('input[name="file"]').value = text;
      form.querySelector('input[name="fileName"]').value = file.name;

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      }
      catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)){
        // Nothing to confirm: the Coordinator says what's wrong with it.
        delete form.dataset.confirm;
      }
      else {
        const present = IGNORED.filter((k) => k in parsed);
        form.dataset.confirm = `Import ${file.name} into ${form.dataset.resourceName}? ` +
          'It replaces the Client\'s config (capabilities, labels, groups, heartbeat settings, …); the Client writes it on its next heartbeat ' +
          'and restarts once it has no job running.\n\n' +
          `Ignored: joinKey, coordinatorUrl and name${present.length ? ` (in this file: ${present.join(', ')})` : ''}, ` +
          'and the Client\'s id, file paths and secrets — each Client keeps its own.';
      }
      form.requestSubmit();
    });
  });
})();
