'use strict';
// Member profiles: relationship flags, and the phone only when that member chose you (they follow you).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

async function setup() {
  const repo = createMemoryRepo();
  const app = createApp({
    repo, now: () => new Date('2026-11-20T12:00:00Z'), mailer: async () => {}, logger: { error() {} },
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const me = async (name) => (await call(name, 'GET', '/me')).body.user;
  const close = () => { server.closeAllConnections(); return new Promise((res) => server.close(res)); };
  return { call, me, close };
}

test('profile: relationship flags show how you are connected', async () => {
  const s = await setup();
  try {
    const ann = await s.me('ann'); const bob = await s.me('bob');
    await s.call('bob', 'POST', '/follows', { userId: ann.id });
    let r = await s.call('bob', 'GET', `/users/${ann.id}`);
    assert.deepEqual(r.body.relationship, { youFollow: true, followsYou: false });
    await s.call('ann', 'POST', '/follows', { userId: bob.id });
    r = await s.call('bob', 'GET', `/users/${ann.id}`);
    assert.deepEqual(r.body.relationship, { youFollow: true, followsYou: true });
  } finally { await s.close(); }
});

test('profile: a member\'s phone is shown only to people they follow', async () => {
  const s = await setup();
  try {
    const ann = await s.me('ann'); const bob = await s.me('bob'); await s.me('zed');
    await s.call('ann', 'POST', '/me/phone', { phone: '+91 98765 43210' });
    await s.call('zed', 'POST', '/follows', { userId: ann.id });   // zed follows ann; ann did not choose zed
    assert.equal((await s.call('zed', 'GET', `/users/${ann.id}`)).body.user.phone, undefined);
    await s.call('ann', 'POST', '/follows', { userId: bob.id });   // ann chose bob
    assert.equal((await s.call('bob', 'GET', `/users/${ann.id}`)).body.user.phone, '+919876543210');
    assert.equal((await s.call('bob', 'GET', `/users/${ann.id}`)).body.user.email, undefined, 'email stays private');
  } finally { await s.close(); }
});

test('profile: unknown members are 404', async () => {
  const s = await setup();
  try {
    await s.me('ann');
    assert.equal((await s.call('ann', 'GET', '/users/99999')).status, 404);
  } finally { await s.close(); }
});
