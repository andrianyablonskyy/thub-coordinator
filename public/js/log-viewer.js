/**
 * @file        packages/coordinator/public/js/log-viewer.js
 * @description Dashboard: a job's log in the log viewer pane — loaded from its end, earlier lines as you scroll up, live lines streamed
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
    info = document.getElementById('log-info'),
    loadAllButton = document.getElementById('log-load-all'),
    PAGE = 1000, // lines per page (routes.js LOG_PAGE)
    PAGE_ALL = 5000, // per request when loading everything
    NEAR_TOP_PX = 150,
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

  // What's loaded, oldest first: a window ending at the log's end. `firstSeq`
  // is where the next earlier page ends; `total` counts every line the job
  // has (loaded or not), live lines included.
  let lines = [],
    firstSeq = null,
    hasMore = false,
    total = 0,
    lastSeq = 0, // newest log line we have (for the live stream to follow on)
    loading = false;

  function fmtTime(iso){
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())){
      return iso;
    }
    const p = Object.fromEntries(timeFormat.formatToParts(d).map(({ type, value }) => [type, value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
  }

  const number = (n) => n.toLocaleString('en-GB');

  function updateInfo(){
    const logLines = lines.filter((l) => l.seq !== undefined).length;
    if (loading){
      info.textContent = 'Loading earlier lines…';
    }
    else if (!total){
      info.textContent = jobActive ? 'No output yet.' : 'No log lines stored — Raw opens the console.log artifact, if there is one.';
    }
    else if (hasMore){
      info.textContent = `Showing the last ${number(logLines)} of ${number(total)} lines — scroll up for earlier ones.`;
    }
    else {
      info.textContent = `All ${number(total)} lines.`;
    }
    loadAllButton.hidden = !hasMore || loading;
  }

  // Search (views/mixins/log-viewer.pug): case-insensitive, literal text,
  // over the loaded lines. Matches are <mark>ed; `current` is the one the
  // arrows step to.
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
      count.textContent = `${current + 1} / ${hits.length}${hasMore ? ' loaded' : ''}`;
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

  // `mode` says what changed, and so where the view should stay:
  //   reset   — first load, a new search or filter: the end (or first match)
  //   live    — a streamed line: follow the end only if the reader is there
  //   prepend — earlier lines loaded above: keep the same lines in view
  function render(mode = 'reset'){
    const wanted = filter.value,
      query = search.value.trim(),
      atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30,
      fromBottom = pre.scrollHeight - pre.scrollTop,
      scrollTop = pre.scrollTop,
      hitsBefore = hits.length,
      shown = lines
        .filter((l) => !wanted || l.stream === wanted)
        .map((l) => `[${fmtTime(l.ts)}] [${l.stream}] ${l.line}`);

    function place(){
      if (mode === 'prepend'){
        pre.scrollTop = pre.scrollHeight - fromBottom;
      }
      else if (mode === 'reset' || atBottom){
        pre.scrollTop = pre.scrollHeight;
      }
      else {
        pre.scrollTop = scrollTop;
      }
    }

    updateInfo();
    if (!query){
      pre.textContent = shown.join('\n');
      hits = [];
      current = -1;
      count.hidden = true;
      prev.disabled = next.disabled = true;
      place();
      fillIfShort();
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
    pre.innerHTML = out.join('\n');
    hits = [...pre.querySelectorAll('mark.thub-log-hit')];
    count.hidden = false;
    count.classList.toggle('text-danger', !hits.length);
    prev.disabled = next.disabled = hits.length < 2;
    if (!hits.length){
      current = -1;
      count.textContent = hasMore ? 'No matches in loaded lines' : 'No matches';
      place();
      fillIfShort();
      return;
    }
    if (mode === 'reset'){
      current = 0;
      showCurrent(true);
    }
    else {
      // Earlier lines add their matches in front: the same match moves down.
      current = mode === 'prepend' ? current + (hits.length - hitsBefore) : current;
      current = Math.min(Math.max(current, 0), hits.length - 1);
      showCurrent(false);
      place();
    }
    fillIfShort();
  }

  // Streamed lines can arrive in bursts: render at most once per frame.
  function renderLive(){
    if (queued){
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render('live');
    });
  }

  // --- loading pages ------------------------------------------------------
  async function fetchPage(before, limit){
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before){
      qs.set('before', String(before));
    }
    const res = await fetch(`/jobs/${encodeURIComponent(jobId)}/logs?${qs}`, { cache: 'no-store' });
    if (!res.ok){
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function absorb(page, where){
    const fetched = page.lines;
    if (fetched.length){
      firstSeq = fetched[0].seq;
    }
    lines = where === 'prepend' ? [...fetched, ...lines] : fetched;
    if (where !== 'prepend' && fetched.length){
      lastSeq = fetched.at(-1).seq;
    }
    hasMore = page.hasMore;
    total = Math.max(total, page.total);
  }

  async function loadEarlier(limit = PAGE){
    if (loading || !hasMore){
      return;
    }
    loading = true;
    updateInfo();
    try {
      absorb(await fetchPage(firstSeq, limit), 'prepend');
    }
    catch {
      info.textContent = 'Couldn’t load earlier lines — scroll up to try again.';
      loading = false;
      return;
    }
    loading = false;
    render('prepend');
  }

  async function loadAll(){
    while (hasMore && !loading){
      await loadEarlier(PAGE_ALL);
    }
  }

  // A filter or "only matching lines" can leave too little to scroll: keep
  // loading earlier pages until there's something to scroll, or nothing left.
  function fillIfShort(){
    if (hasMore && !loading && pre.scrollHeight <= pre.clientHeight + NEAR_TOP_PX){
      loadEarlier();
    }
  }

  pre.addEventListener('scroll', () => {
    if (pre.scrollTop < NEAR_TOP_PX){
      loadEarlier();
    }
  }, { passive: true });
  loadAllButton.addEventListener('click', loadAll);

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

  // --- start: the end of the log, then (active job) live lines after it ----
  (async () => {
    try {
      absorb(await fetchPage(null, PAGE), 'replace');
    }
    catch {
      info.textContent = 'Couldn’t load the log — reload the page to try again.';
      return;
    }
    render();

    // Already finished when the page loaded: the output will never change
    // again — no EventSource, no live connection. (Opening a stream here used
    // to reload the page on its immediate "end" event, forever.)
    if (!jobActive){
      return;
    }
    // Live lines start right after what's loaded; on a reconnect the
    // browser resumes from the last one it got (Last-Event-ID).
    const source = new EventSource(`/jobs/${encodeURIComponent(jobId)}/stream?after=${lastSeq}`);
    source.addEventListener('log', (e) => {
      const seq = Number(e.lastEventId) || undefined;
      if (seq && seq <= lastSeq){
        return; // already have it
      }
      lastSeq = seq ?? lastSeq;
      lines.push({ ...JSON.parse(e.data), seq });
      total += 1;
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
})();
