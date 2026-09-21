(function () {
  const pre = document.getElementById('log-viewer');
  if (!pre) return;
  const jobId = pre.dataset.jobId;
  const filter = document.getElementById('stream-filter');
  const lines = [];

  function render() {
    const wanted = filter.value;
    pre.textContent = lines
      .filter((l) => !wanted || l.stream === wanted)
      .map((l) => `[${l.ts}] [${l.stream}] ${l.line}`)
      .join('\n');
    pre.scrollTop = pre.scrollHeight;
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
    setTimeout(() => window.location.reload(), 1500);
  });
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do here.
  };

  filter.addEventListener('change', render);
})();
