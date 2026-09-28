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

  function render(){
    const wanted = filter.value;
    pre.textContent = lines
      .filter((l) => !wanted || l.stream === wanted)
      .map((l) => `[${fmtTime(l.ts)}] [${l.stream}] ${l.line}`)
      .join('\n');
    pre.scrollTop = pre.scrollHeight;
  }

  filter.addEventListener('change', render);

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
    render();
  });
  source.addEventListener('state', (e) => {
    const { state, resource } = JSON.parse(e.data);
    lines.push({ ts: new Date().toISOString(), stream: 'state', line: `-> ${state}${resource ? ' on ' + resource : ''}` });
    render();
  });
  source.addEventListener('end', (e) => {
    const { state } = JSON.parse(e.data);
    lines.push({ ts: new Date().toISOString(), stream: 'state', line: `job finished: ${state}` });
    render();
    source.close();
    // The job was active when we opened this page and just finished —
    // reload once to pick up the now-final badge/artifacts list.
    setTimeout(() => window.location.reload(), 1500);
  });
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do here.
  };
})();
