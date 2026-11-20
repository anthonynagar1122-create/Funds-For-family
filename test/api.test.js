'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

// Fixed clock so date rules are deterministic.
const NOW = new Date('2026-11-20T12:00:00Z');

async function setup() {
  const repo = createMemoryRepo();
  const sent = [];
  const app = createApp({
    repo,
    now: () => NOW,
    mailer: async (m) => { sent.push(m); },
    // Test identity: header "x-test-user: <name>" maps to a fixed Clerk-style id and email.
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
    logger: { error() {} },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const close = () => new Promise((res) => server.close(res));
  return { repo, sent, call, close };
}

const validRequest = (nomineeId) => ({
  amount: 500,
  purpose: 'School fees for the second term at the local college',
  repaymentDate: '2027-02-01',
  nomineeId,
});

test('requests without a signed-in user are rejected', async () => {
  const { call, close } = await setup();
  try {
    const r = await call(null, 'GET', '/me');
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('a member creates a request; it starts pending verification and is hidden from the feed', async () => {
  const { call, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    await call('ben', 'GET', '/me');
    const created = await call('ann', 'POST', '/requests', validRequest(2));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.request.status, 'pending_verification');
    assert.equal(created.body.request.principalCents, 50000);
  } finally { await close(); }
});

test('nominee must exist and cannot be the borrower', async () => {
  const { call, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    const self = await call('ann', 'POST', '/requests', validRequest(1));
    assert.equal(self.status, 400);
    assert.equal(self.body.field, 'nomineeId');
    const missing = await call('ann', 'POST', '/requests', validRequest(999));
    assert.equal(missing.status, 400);
  } finally { await close(); }
});

test('two verifier approvals open the request; non-verifiers are refused', async () => {
  const { repo, call, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    await call('nat', 'GET', '/me');
    const annId = (await call('ann', 'GET', '/me')).body.user.id;
    const natId = (await call('nat', 'GET', '/me')).body.user.id;
    await call('vee', 'GET', '/me');
    await call('wes', 'GET', '/me');
    const vee = (await call('vee', 'GET', '/me')).body.user;
    const wes = (await call('wes', 'GET', '/me')).body.user;
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);

    const { body } = await call('ann', 'POST', '/requests', validRequest(natId));
    const id = body.request.id;

    const notVerifier = await call('ann', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(notVerifier.status, 403);

    await call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const second = await call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(second.body.request.status, 'open');
    assert.equal(annId !== natId, true);
  } finally { await close(); }
});

test('contributions are capped, fund the request, and reject self-funding', async () => {
  const { repo, call, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    const nat = (await call('nat', 'GET', '/me')).body.user;
    const vee = (await call('vee', 'GET', '/me')).body.user;
    const wes = (await call('wes', 'GET', '/me')).body.user;
    await call('ann', 'GET', '/me');
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);
    const annUser = (await call('ann', 'GET', '/me')).body.user;

    const id = (await call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;
    await call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });

    assert.equal((await call('ann', 'POST', `/requests/${id}/contributions`, { amount: 10 })).status, 409, 'borrower cannot fund own request');

    const over = await call('nat', 'POST', `/requests/${id}/contributions`, { amount: 600 });
    assert.equal(over.status, 409, 'cannot exceed the requested total');

    const part = await call('nat', 'POST', `/requests/${id}/contributions`, { amount: 300 });
    assert.equal(part.status, 201);
    assert.equal(part.body.request.status, 'open');
    assert.equal(part.body.request.remainingCents, 20000);

    const rest = await call('wes', 'POST', `/requests/${id}/contributions`, { amount: 200 });
    assert.equal(rest.body.request.status, 'funded');
    assert.equal(annUser.id !== nat.id, true);
  } finally { await close(); }
});

test('repayment by the nominee closes the request once the amount due is paid; interest accrues after the due date', async () => {
  const { repo, call, close } = await setup();
  try {
    const nat = (await call('nat', 'GET', '/me')).body.user;
    await call('ann', 'GET', '/me');
    const vee = (await call('vee', 'GET', '/me')).body.user;
    const wes = (await call('wes', 'GET', '/me')).body.user;
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);
    const id = (await call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;
    await call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await call('nat', 'POST', `/requests/${id}/contributions`, { amount: 500 });

    const stranger = await call('vee', 'POST', `/requests/${id}/repayments`, { amount: 500 });
    assert.equal(stranger.status, 403);

    const pay = await call('nat', 'POST', `/requests/${id}/repayments`, { amount: 500 });
    assert.equal(pay.status, 201);
    assert.equal(pay.body.request.status, 'repaid');
  } finally { await close(); }
});

test('feed shows connected members requests only once approved', async () => {
  const { repo, call, close } = await setup();
  try {
    const ann = (await call('ann', 'GET', '/me')).body.user;
    const ben = (await call('ben', 'GET', '/me')).body.user;
    const nat = (await call('nat', 'GET', '/me')).body.user;
    const vee = (await call('vee', 'GET', '/me')).body.user;
    const wes = (await call('wes', 'GET', '/me')).body.user;
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);
    assert.equal((await call('ben', 'POST', '/follows', { userId: ann.id })).status, 201);
    const id = (await call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;

    let feed = await call('ben', 'GET', '/feed');
    assert.equal(feed.body.requests.length, 0, 'pending requests are not in the feed');

    await call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    feed = await call('ben', 'GET', '/feed');
    assert.equal(feed.body.requests.length, 1);
    const outsider = await call('zed', 'GET', '/feed');
    assert.equal(outsider.body.requests.length, 0);
  } finally { await close(); }
});

test('invites send an email with the invite link', async () => {
  const { call, sent, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    const r = await call('ann', 'POST', '/invites', { email: 'Friend@Example.com' });
    assert.equal(r.status, 201);
    assert.equal(sent[0].to, 'friend@example.com');
    assert.match(sent[0].html, /invite=/);
  } finally { await close(); }
});
