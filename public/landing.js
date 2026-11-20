// Progressive enhancement only. Without JavaScript every section is fully visible.
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const items = document.querySelectorAll('.reveal, .reveal-group');
  if (!('IntersectionObserver' in window) || reduce.matches) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
  items.forEach((el) => io.observe(el));
})();
