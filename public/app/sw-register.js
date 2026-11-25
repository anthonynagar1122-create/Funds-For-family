'use strict';
// Registers the offline worker for /app/. Kept in its own file so the page's Content-Security-Policy needs no inline script.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/app/' }).catch(() => {}));
}
