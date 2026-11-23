'use strict';
// Shared API test harness. Builds the app on the in-memory repo with a fixed clock and a header-driven identity.
//   x-test-user: <name>   -> { clerkId: 'clerk_<name>', name, email: '<name>@example.com' }
//   x-test-email: <email> -> overrides the email for that request
const { createApp } = require('../../src/app');
const { createMemoryRepo } = require('../../src/memory-repo');

const DEFAULT_NOW = new Date('2026-11-20T12:00:00Z');

async function setup({ admitAll = true, ownerEmail = '', now = DEFAULT_NOW, repo = createMemoryRepo() } = {}) {
  const sent = [];
  const logged = [];
  const clock = { now };
  const app = createApp({
    repo,
    now: () => clock.now,
    mailer: async (m) => { sent.push(m); },
    ownerEmail,
    admit: async () => admitAll,
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      if (!name) return null;
      return { clerkId: `clerk_${name}`, name, email: req.headers['x-test-email'] || `${name}@example.com` };
    },
    logger: { error: (...a) => logged.push(a) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  // call(user, method, path, body, raw, extraHeaders): raw replaces the JSON body (for malformed-body tests).
  const call = async (user, method, p, body, raw, extraHeaders = {}) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (user) headers['x-test-user'] = user;
    const payload = method === 'GET' ? undefined : (raw ?? (body ? JSON.stringify(body) : undefined));
    const r = await fetch(base + p, { method, headers, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, body: json, text };
  };
  const setNow = (d) => { clock.now = d; };
  const close = () => { server.closeAllConnections(); return new Promise((res) => server.close(res)); };
  return { repo, sent, logged, call, close, port, setNow };
}

module.exports = { setup, DEFAULT_NOW };
