/**
 * @file        packages/coordinator/public/js/log-viewer.js
 * @description Dashboard: streams or fetches a job's log output into the log viewer pane
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
  const pre = document.getElementById('log-viewer');
  if (!pre){
    return;
  }
  const jobId = pre.dataset.jobId,
    jobActive = pre.dataset.jobActive === 'true',
    filter = document.getElementById('stream-filter'),
    lines = [],
    // Same dd/mm/yyyy HH:MM:SS, 24-hour format and profile time zone as
    // every server-rendered date (thub-common formatDateTime).
    timeFormat = new Intl.DateTimeFormat('en-GB', {
      timeZone: pre.dataset.timeZone || undefined,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });

  function fmtTime(iso){
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())){
      return iso;
    }
    const p = Object.fromEntries(timeFormat.formatToParts(d).map(({ type, value }) => [type, value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
  }

  // Search (views/mixins/log-viewer.pug): case-insensitive, literal text.
  // Matches are <mark>ed; `current` is the one the arrows step to.
  const search = document.getElementById('log-search'),
    onlyMatching = document.getElementById('log-search-only'),
    count = document.getElementById('log-search-count'),
    prev = document.getElementById('log-search-prev'),
    next = document.getElementById('log-search-next');
  let hits = [],
    current = -1,
    queued = false;

  function escapeHtml(s){
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  }

  function showCurrent(scroll){
    hits.forEach((el, i) => el.classList.toggle('current', i === current));
    if (current >= 0){
      count.textContent = `${current + 1} / ${hits.length}`;
      if (scroll){
        const el = hits[current];
        pre.scrollTop = el.offsetTop - pre.clientHeight / 2;
      }
    }
  }

  function step(delta){
    if (!hits.length){
      return;
    }
    current = (current + delta + hits.length) % hits.length;
    showCurrent(true);
  }

  // `live`: re-rendered for a newly streamed line — keep the reader's place
  // while searching; without a search, follow the end of the log as before.
  function render({ live = false } = {}){
    const wanted = filter.value,
      query = search.value.trim(),
      shown = lines
        .filter((l) => !wanted || l.stream === wanted)
        .map((l) => `[${fmtTime(l.ts)}] [${l.stream}] ${l.line}`);

    if (!query){
      pre.textContent = shown.join('\n');
      hits = [];
      current = -1;
      count.hidden = true;
      prev.disabled = next.disabled = true;
      pre.scrollTop = pre.scrollHeight;
      return;
    }

    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      out = [];
    for (const text of shown){
      let last = 0,
        html = '',
        m;
      re.lastIndex = 0;
      while ((m = re.exec(text))){
        html += `${escapeHtml(text.slice(last, m.index))}<mark class="thub-log-hit">${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      if (last || !onlyMatching.checked){
        out.push(html + escapeHtml(text.slice(last)));
      }
    }
    const scrollTop = pre.scrollTop;
    pre.innerHTML = out.join('\n');
    hits = [...pre.querySelectorAll('mark.thub-log-hit')];
    count.hidden = false;
    count.classList.toggle('text-danger', !hits.length);
    prev.disabled = next.disabled = hits.length < 2;
    if (!hits.length){
      current = -1;
      count.textContent = 'No matches';
      return;
    }
    if (live){
      current = Math.min(Math.max(current, 0), hits.length - 1);
      showCurrent(false);
      pre.scrollTop = scrollTop;
    }
    else {
      current = 0;
      showCurrent(true);
    }
  }

  // Streamed lines can arrive in bursts: render at most once per frame.
  function renderLive(){
    if (queued){
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render({ live: true });
    });
  }

  let typing;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => render(), 150);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
    else if (e.key === 'Escape' && search.value){
      e.preventDefault();
      search.value = '';
      render();
    }
  });
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  onlyMatching.addEventListener('change', () => render());
  filter.addEventListener('change', () => render());

  // Already finished when the page loaded: the output will never change
  // again, so just fetch it once — no EventSource, no live connection, no
  // reload. (Opening a stream here used to trigger an auto-reload once it
  // immediately got the job's "end" event, which reloaded the page, which
  // re-opened the stream, which reloaded again — an infinite loop for
  // anyone viewing a finished job.)
  if (!jobActive){
    fetch(`/jobs/${jobId}/logs`)
      .then((r) => r.json())
      .then(({ lines: fetched }) => {
        lines.push(...fetched);
        render();
      })
      .catch(() => {});
    return;
  }

  const source = new EventSource(`/jobs/${jobId}/stream`);
  source.addEventListener('log', (e) => {
    lines.push(JSON.parse(e.data));
    renderLive();
  });
  source.addEventListener('state', (e) => {
    const { state, resource } = JSON.parse(e.data);
    lines.push({ ts: new Date().toISOString(), stream: 'state', line: `-> ${state}${resource ? ' on ' + resource : ''}` });
    renderLive();
  });
  source.addEventListener('end', (e) => {
    const { state } = JSON.parse(e.data);
    lines.push({ ts: new Date().toISOString(), stream: 'state', line: `job finished: ${state}` });
    renderLive();
    source.close();
    // The job was active when we opened this page and just finished —
    // reload once to pick up the now-final badge/artifacts list.
    setTimeout(() => window.location.reload(), 1500);
  });
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do here.
  };
})();
