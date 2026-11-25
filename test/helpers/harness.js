'use strict';
// Shared API test harness. Builds the app on the in-memory repo with a fixed clock and a header-driven identity.
//   x-test-user: <name>   -> { clerkId: 'clerk_<name>', name, email: '<name>@example.com' }
//   x-test-email: <email> -> overrides the email for that request
//   x-test-no-email: 1    -> identity has no verified email (email: null)
const { createApp } = require('../../src/app');
const { createMemoryRepo } = require('../../src/memory-repo');

const DEFAULT_NOW = new Date('2026-11-20T12:00:00Z');

async function setup({ admitAll = true, ownerEmail = '', now = DEFAULT_NOW, repo = createMemoryRepo(), deleteClerkUser } = {}) {
  const sent = [];
  const logged = [];
  const clock = { now };
  const app = createApp({
    repo,
    now: () => clock.now,
    mailer: async (m) => { sent.push(m); },
    ownerEmail,
    ...(deleteClerkUser ? { deleteClerkUser } : {}),
    admit: async () => admitAll,
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      if (!name) return null;
      if (req.headers['x-test-no-email']) return { clerkId: `clerk_${name}`, name, email: null };
      return { clerkId: `clerk_${name}`, name, email: req.headers['x-test-email'] || `${name}@example.com` };
    },
    logger: { error: (...a) => logged.push(a) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  // call(user, method, path, body, raw, extraHeaders): raw replaces the JSON body (for malformed-body tests).
  // A payment sent without a UTR gets a unique one, because a UTR is now required and unique per request.
  // Tests that need a specific UTR (or none) pass `utr` themselves.
  let fixtureUtr = 0;
  const withUtr = (method, p, body) => {
    if (method !== 'POST' || !/\/(contributions|repayments)$/.test(p) || !body || typeof body !== 'object') return body;
    if (Object.prototype.hasOwnProperty.call(body, 'utr')) return body;
    fixtureUtr += 1;
    return { ...body, utr: `FIXTURE${String(fixtureUtr).padStart(8, '0')}` };
  };
  const call = async (user, method, p, body, raw, extraHeaders = {}) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (user) headers['x-test-user'] = user;
    const sentBody = raw === undefined ? withUtr(method, p, body) : body;
    const payload = method === 'GET' ? undefined : (raw ?? (sentBody ? JSON.stringify(sentBody) : undefined));
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
