(() => {
  'use strict';
  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.error) || `Request failed (${status})`);
      this.name = 'ApiError';
      this.status = status;
      this.code = data && data.code;
      this.field = data && data.field;
    }
  }

  // path is relative to /api, e.g. Api.get('/feed'). opts.headers adds headers (for example x-invite-token).
  async function request(method, path, body, opts = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    });
    // The service worker marks answers it served from its saved copy.
    const fromCache = res.headers.get('x-from-sw-cache') === '1';
    window.Api.fromCache = fromCache;
    const note = document.getElementById('offline-note');
    if (note) note.hidden = !fromCache;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  window.ApiError = ApiError;
  window.Api = {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body ?? {}, opts),
    patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
    delete: (path, opts) => request('DELETE', path, undefined, opts),
    request,
    fromCache: false,
    // Forget saved API answers (sign-out), so the next person on this device never sees them.
    async clearSaved() {
      if (!('caches' in window)) return;
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith('/api/')) await c.delete(r);
      }
    },
  };
})();
