// Motion prototype. Progressive: without JS the cards are visible. Reduced motion disables movement.
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fine = window.matchMedia('(pointer: fine)');
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));
  const round = (v) => Math.round(v * 100) / 100;

  // Scroll zoom: mark each card visible once it enters the viewport.
  const zoomed = document.querySelectorAll('[data-zoom]');
  if (reduce.matches || !('IntersectionObserver' in window)) {
    zoomed.forEach((el) => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
    }, { threshold: 0.15 });
    zoomed.forEach((el) => io.observe(el));
  }

  if (reduce.matches || !fine.matches) return; // no pointer effects for reduced motion or touch

  // Spotlight: write the pointer position as percentages, read by CSS.
  document.querySelectorAll('[data-spotlight]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${round(((e.clientX - r.left) / r.width) * 100)}%`);
      el.style.setProperty('--my', `${round(((e.clientY - r.top) / r.height) * 100)}%`);
    });
  });

  // Tilt: up to 4 degrees, flat again on leave.
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

  // Magnetic: the button leans toward the pointer, at most 4 px.
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
