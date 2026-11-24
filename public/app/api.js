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
  };
})();
