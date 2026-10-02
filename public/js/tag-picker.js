/**
 * @file        packages/coordinator/public/js/tag-picker.js
 * @description Dashboard: a chip picker (the runner card's Groups tab) — chosen items as removable chips,
 *              a search box that suggests the rest; each chip carries its own hidden form input
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

// Markup (views/mixins/client-config.pug, groupsPane):
//   [data-tag-picker data-tag-name data-options='[{value, label, hint}]']
//     [data-tag-box] > span[data-tag=value] (label, hidden input, [data-tag-remove]) … input[data-tag-input]
//     ul[data-tag-menu]
// Typing filters the options not chosen yet (by name or comment); ↑/↓ move,
// Enter or a click adds, Backspace in an empty box removes the last chip,
// Esc closes the list (not the modal around it).
(function (){
  const MAX_SHOWN = 50,

    pickerOf = (el) => el.closest('[data-tag-picker]'),
    optionsOf = (picker) => {
      try {
        return JSON.parse(picker.dataset.options || '[]');
      }
      catch {
        return [];
      }
    },
    chosen = (picker) => new Set([...picker.querySelectorAll('[data-tag]')].map((t) => t.dataset.tag)),
    menuOf = (picker) => picker.querySelector('[data-tag-menu]'),
    inputOf = (picker) => picker.querySelector('[data-tag-input]');

  function closeMenu(picker){
    const menu = menuOf(picker);
    menu.classList.remove('show');
    menu.replaceChildren();
    inputOf(picker)?.setAttribute('aria-expanded', 'false');
  }

  function openMenu(picker){
    const input = inputOf(picker),
      menu = menuOf(picker),
      q = input.value.trim().toLowerCase(),
      taken = chosen(picker),
      matches = optionsOf(picker)
        .filter((o) => !taken.has(o.value) && (!q || o.label.toLowerCase().includes(q) || o.hint.toLowerCase().includes(q)))
        .slice(0, MAX_SHOWN);
    menu.replaceChildren(...(matches.length ? matches.map((o, i) => {
      const li = document.createElement('li'),
        item = document.createElement('button');
      item.type = 'button';
      item.className = `dropdown-item${i === 0 ? ' active' : ''}`;
      item.setAttribute('role', 'option');
      item.dataset.tagOption = o.value;
      item.tabIndex = -1;
      item.append(document.createTextNode(o.label));
      if (o.hint){
        const hint = document.createElement('span');
        hint.className = 'small text-body-secondary ms-2';
        hint.textContent = o.hint;
        item.append(hint);
      }
      li.append(item);
      return li;
    }) : [Object.assign(document.createElement('li'), {
      className: 'dropdown-item-text small text-body-secondary',
      textContent: optionsOf(picker).length === taken.size ? 'All groups are added' : 'No matching group'
    })]));
    menu.classList.add('show');
    input.setAttribute('aria-expanded', 'true');
  }

  function addTag(picker, value){
    const option = optionsOf(picker).find((o) => o.value === value);
    if (!option || chosen(picker).has(value)){
      return;
    }
    const chip = document.createElement('span'),
      label = document.createElement('span'),
      hidden = document.createElement('input'),
      remove = document.createElement('button');
    chip.className = 'thub-tag';
    chip.dataset.tag = value;
    label.textContent = option.label;
    hidden.type = 'hidden';
    hidden.name = picker.dataset.tagName;
    hidden.value = value;
    remove.type = 'button';
    remove.className = 'thub-tag-remove';
    remove.dataset.tagRemove = '';
    remove.setAttribute('aria-label', `Remove ${option.label}`);
    remove.innerHTML = '<i class="bi bi-x"></i>';
    chip.append(label, hidden, remove);
    const input = inputOf(picker);
    input.before(chip);
    input.value = '';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function removeTag(chip){
    const picker = pickerOf(chip);
    chip.remove();
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const editable = (picker) => picker && inputOf(picker) && !picker.closest('fieldset')?.disabled;

  document.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-tag-remove]'),
      option = e.target.closest('[data-tag-option]'),
      box = e.target.closest('[data-tag-box]'),
      picker = pickerOf(e.target);
    if (remove && editable(picker)){
      removeTag(remove.closest('[data-tag]'));
      // Focus back to the box, without opening the list over what's below.
      picker.dataset.quiet = '1';
      inputOf(picker).focus();
      closeMenu(picker);
    }
    else if (option && editable(picker)){
      addTag(picker, option.dataset.tagOption);
      openMenu(picker);
      inputOf(picker).focus();
    }
    else if (box && editable(picker)){
      inputOf(picker).focus();
    }
    // A click anywhere else closes every open list.
    document.querySelectorAll('[data-tag-picker]').forEach((p) => {
      if (p !== picker){
        closeMenu(p);
      }
    });
  });

  document.addEventListener('focusin', (e) => {
    const picker = e.target.matches('[data-tag-input]') ? pickerOf(e.target) : null;
    if (picker?.dataset.quiet){
      delete picker.dataset.quiet;
    }
    else if (picker && editable(picker)){
      openMenu(picker);
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-tag-input]')){
      openMenu(pickerOf(e.target));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-tag-input]')){
      return;
    }
    const picker = pickerOf(e.target),
      menu = menuOf(picker),
      items = [...menu.querySelectorAll('[data-tag-option]')],
      at = items.findIndex((i) => i.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if (!menu.classList.contains('show')){
        return openMenu(picker);
      }
      if (items.length){
        const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((i, n) => i.classList.toggle('active', n === next));
        items[next].scrollIntoView({ block: 'nearest' });
      }
    }
    else if (e.key === 'Enter'){
      e.preventDefault(); // never submits the form from here
      if (at >= 0){
        addTag(picker, items[at].dataset.tagOption);
        openMenu(picker);
      }
    }
    else if (e.key === 'Backspace' && !e.target.value){
      const chips = picker.querySelectorAll('[data-tag]');
      if (chips.length){
        removeTag(chips[chips.length - 1]);
        openMenu(picker);
      }
    }
    else if (e.key === 'Escape' && menu.classList.contains('show')){
      e.stopPropagation(); // the list closes, the modal stays
      closeMenu(picker);
    }
    else if (e.key === 'Tab'){
      closeMenu(picker);
    }
  }, true); // capture: ahead of the modal's own Esc handling
})();
