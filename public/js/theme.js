(function () {
  const root = document.documentElement;
  const key = 'thub-theme';

  function apply(theme) {
    root.setAttribute('data-bs-theme', theme);
  }

  const stored = localStorage.getItem(key);
  if (stored) apply(stored);

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    localStorage.setItem(key, next);
  });
})();
