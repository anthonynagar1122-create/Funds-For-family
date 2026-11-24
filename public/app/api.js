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

  // The last member id seen from a live /api/me on this device.
  const USER_KEY = 'ff-user';
  function savedUser() { try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; } }

  // path is relative to /api, e.g. Api.get('/feed'). opts.headers adds headers (for example x-invite-token).
  async function request(method, path, body, opts = {}) {
    const who = savedUser();
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      // x-ff-user lets the service worker serve a saved copy only to the member it was saved for.
      headers: { 'content-type': 'application/json', ...(who ? { 'x-ff-user': who } : {}), ...(opts.headers || {}) },
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
    setSavedUser(id) { try { if (id == null) localStorage.removeItem(USER_KEY); else localStorage.setItem(USER_KEY, String(id)); } catch { /* storage unavailable */ } },
    // Forget saved API answers (sign-out), so the next person on this device never sees them.
    async clearSaved() {
      window.Api.setSavedUser(null);
      if (!('caches' in window)) return;
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith('/api/')) await c.delete(r);
      }
    },
  };
})();
