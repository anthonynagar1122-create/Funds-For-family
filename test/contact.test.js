'use strict';
// Lender safety: lenders reach the borrower (call / WhatsApp) before contributing, and confirm they did.
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/rules');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

const NOW = new Date('2026-11-20T12:00:00Z');
async function setup() {
  const repo = createMemoryRepo();
  const app = createApp({
    repo, now: () => NOW, mailer: async () => {}, logger: { error() {} },
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
  return { repo, call, me, close };
}
const request = (nomineeId, extra = {}) => ({ amount: 500, purpose: 'School fees for the second term at the local college', repaymentDate: '2027-02-01', nomineeId, ...extra });

// Ann borrows (phone set), Lee is in her circle (she follows him), the request is approved and open.
async function openForLee(s) {
  const ann = await s.me('ann'); const nat = await s.me('nat'); const vee = await s.me('vee'); const wes = await s.me('wes'); const lee = await s.me('lee');
  await s.repo.setVerifier(vee.id, true); await s.repo.setVerifier(wes.id, true);
  await s.call('ann', 'POST', '/follows', { userId: lee.id });
  const id = (await s.call('ann', 'POST', '/requests', request(nat.id, { phone: '+44 7700 900123' }))).body.request.id;
  await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  return { ann, lee, id };
}

test('phone numbers are normalised to international format, and junk is refused', () => {
  assert.deepEqual(rules.validatePhone('+44 (0)7700-900.123'), { ok: true, value: '+4407700900123' });
  assert.deepEqual(rules.validatePhone('+91 98765 43210'), { ok: true, value: '+919876543210' });
  assert.equal(rules.validatePhone('').ok, false);
  assert.equal(rules.validatePhone('12345').ok, false, 'too short');
  assert.equal(rules.validatePhone('call me maybe').ok, false);
  assert.equal(rules.validatePhone('+1234567890123456').ok, false, 'too long');
});

test('a member saves their phone; only they see it on their own profile', async () => {
  const s = await setup();
  try {
    await s.me('ann');
    const bad = await s.call('ann', 'POST', '/me/phone', { phone: 'abc' });
    assert.equal(bad.status, 400); assert.equal(bad.body.field, 'phone');
    const ok = await s.call('ann', 'POST', '/me/phone', { phone: '+91 98765 43210' });
    assert.equal(ok.status, 200); assert.equal(ok.body.user.phone, '+919876543210');
    assert.equal((await s.call('ann', 'GET', '/me')).body.user.phone, '+919876543210');
  } finally { await s.close(); }
});

test('requesting money needs a phone number; the form can send it with the request', async () => {
  const s = await setup();
  try {
    await s.me('ann'); const nat = await s.me('nat');
    const missing = await s.call('ann', 'POST', '/requests', request(nat.id));
    assert.equal(missing.status, 400); assert.equal(missing.body.field, 'phone');
    const withPhone = await s.call('ann', 'POST', '/requests', request(nat.id, { phone: '+1 555 010 0100' }));
    assert.equal(withPhone.status, 201);
    assert.equal((await s.call('ann', 'GET', '/me')).body.user.phone, '+15550100100', 'saved to the profile');
    assert.equal((await s.call('ann', 'POST', '/requests', request(nat.id))).status, 201, 'next time it is already there');
  } finally { await s.close(); }
});

test('the borrower\'s circle sees their name and phone on the request and in the feed', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openForLee(s);
    const detail = await s.call('lee', 'GET', `/requests/${id}`);
    assert.deepEqual(detail.body.request.borrower, { id: ann.id, name: 'ann', phone: '+447700900123' });
    const feed = await s.call('lee', 'GET', '/feed');
    assert.equal(feed.body.requests[0].borrower.phone, '+447700900123');
  } finally { await s.close(); }
});

test('the phone never leaks outside the circle: profile lookup, search, suggestions, connections', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openForLee(s);
    await s.me('zed');
    assert.equal((await s.call('zed', 'GET', `/requests/${id}`)).status, 404);
    const looks = [
      (await s.call('zed', 'GET', `/users/${ann.id}`)).body,
      (await s.call('zed', 'GET', '/users?q=ann')).body,
      (await s.call('lee', 'GET', '/connections')).body,
      (await s.call('lee', 'GET', '/suggestions')).body,
    ];
    assert.doesNotMatch(JSON.stringify(looks), /7700900123/);
  } finally { await s.close(); }
});

test('a lender must confirm they spoke with the borrower before contributing', async () => {
  const s = await setup();
  try {
    const { id } = await openForLee(s);
    const unconfirmed = await s.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 50 });
    assert.equal(unconfirmed.status, 400); assert.equal(unconfirmed.body.field, 'confirmedContact');
    const truthy = await s.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 50, confirmedContact: 'yes' });
    assert.equal(truthy.status, 400, 'only an explicit true counts');
    const ok = await s.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 50, confirmedContact: true });
    assert.equal(ok.status, 201);
  } finally { await s.close(); }
});
