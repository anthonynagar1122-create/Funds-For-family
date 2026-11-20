// Progressive enhancement only. Without JavaScript every section is fully visible.
// Reduced motion and touch devices get the static page: no tilt, no magnetic pull.
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fine = window.matchMedia('(pointer: fine)');
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));
  const round = (v) => Math.round(v * 100) / 100;

  // Reveal (section copy) and zoom (cards): each element is marked visible once it enters the viewport.
  const revealTargets = document.querySelectorAll('.reveal, .reveal-group, [data-zoom]');
  if (reduce.matches || !('IntersectionObserver' in window)) {
    revealTargets.forEach((el) => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
    revealTargets.forEach((el) => io.observe(el));
  }

  if (reduce.matches || !fine.matches) return;

  // Spotlight: the pointer position, as percentages, for the CSS highlight.
  document.querySelectorAll('[data-spotlight]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${round(((e.clientX - r.left) / r.width) * 100)}%`);
      el.style.setProperty('--my', `${round(((e.clientY - r.top) / r.height) * 100)}%`);
    });
  });

  // Tilt: up to 4 degrees toward the pointer; flat again on leave.
  document.querySelectorAll('[data-tilt]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      const rx = round(clamp(-py * 8, 4));
      const ry = round(clamp(px * 8, 4));
      el.style.setProperty('--rx', `${rx}`);
      el.style.setProperty('--ry', `${ry}`);
      el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--rx', '0');
      el.style.setProperty('--ry', '0');
      el.style.transform = '';
    });
  });

  // Magnetic: a primary CTA leans toward the pointer, at most 4 px.
  document.querySelectorAll('[data-magnetic]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const dx = clamp((e.clientX - (r.left + r.width / 2)) * 0.15, 4);
      const dy = clamp((e.clientY - (r.top + r.height / 2)) * 0.15, 4);
      el.style.transform = `translate(${round(dx)}px, ${round(dy)}px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
})();
