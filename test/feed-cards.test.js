'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');
const NOW = new Date('2026-11-20T12:00:00Z');

async function setup() {
  const repo = createMemoryRepo();
  const app = createApp({
    repo, now: () => NOW, mailer: async () => {},
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
    logger: { error() {} },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const close = () => { server.closeAllConnections(); return new Promise((res) => server.close(res)); };
  return { repo, call, close };
}

test('feed cards carry the amount raised so far', async () => {
  const s = await setup();
  try {
    const ann = (await s.call('ann', 'GET', '/me')).body.user;
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const vee = (await s.call('vee', 'GET', '/me')).body.user;
    const wes = (await s.call('wes', 'GET', '/me')).body.user;
    await s.repo.setVerifier(vee.id, true);
    await s.repo.setVerifier(wes.id, true);
    await s.call('ben', 'GET', '/me');
    await s.call('ben', 'POST', '/follows', { userId: ann.id });
    const id = (await s.call('ann', 'POST', '/requests', { amount: 500, purpose: 'School fees for the second term at the college', repaymentDate: '2027-02-01', category: 'education', trustedContactId: nat.id })).body.request.id;
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('zed', 'GET', '/me');
    await s.call('zed', 'POST', `/requests/${id}/contributions`, { amount: 120 });
    const feed = await s.call('ben', 'GET', '/feed');
    assert.equal(feed.status, 200);
    assert.equal(feed.body.requests[0].raisedCents, 12000);
  } finally { await s.close(); }
});
