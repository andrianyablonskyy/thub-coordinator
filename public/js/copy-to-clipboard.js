(function () {
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
      } catch {
        return; // clipboard unavailable (e.g. non-secure context) — fail quietly
      }
      const icon = btn.querySelector('i');
      if (!icon) return;
      const original = icon.className;
      icon.className = 'bi bi-check2';
      setTimeout(() => {
        icon.className = original;
      }, 1200);
    });
  });
})();
