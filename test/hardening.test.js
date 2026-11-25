'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

const NOW = new Date('2026-11-20T12:00:00Z');

async function setup(options = {}) {
  const repo = createMemoryRepo();
  const deleted = [];
  const app = createApp({
    repo,
    now: () => NOW,
    mailer: async () => {},
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
    deleteIdentity: async (clerkId) => { deleted.push(clerkId); },
    logger: { error() {} },
    ...options,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, p, body, headers = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (user) h['x-test-user'] = user;
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
  };
  const close = () => new Promise((res) => server.close(res));
  return { repo, deleted, call, close };
}

// Lenders see a request only if the borrower follows them (the circle rule), so ann follows each lender.
async function inCircle(s, names) {
  const ann = await s.call('ann', 'GET', '/me');
  for (const n of names) {
    const u = await s.call(n, 'GET', '/me');
    await s.call('ann', 'POST', '/follows', { userId: u.body.user.id });
  }
  return ann;
}

// A borrower "ann" with a nominee "nat", opened for contributions directly in the repo.
async function openRequest(s, principal = 50000, lenders = []) {
  await inCircle(s, lenders);
  const nat = await s.call('nat', 'GET', '/me');
  const created = await s.call('ann', 'POST', '/requests', {
    amount: principal / 100,
    purpose: 'School fees for the second term at the local college',
    repaymentDate: '2027-02-01',
    nomineeId: nat.body.user.id,
    phone: '+1 555 010 0100',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  s.repo._state.requests.get(id).status = 'open';
  return id;
}

test('invites are rate limited per member', async () => {
  const s = await setup({ rateLimits: { invites: { max: 2, windowMs: 60000 } } });
  try {
    await s.call('ann', 'GET', '/me');
    assert.equal((await s.call('ann', 'POST', '/invites', {})).status, 201);
    assert.equal((await s.call('ann', 'POST', '/invites', {})).status, 201);
    const blocked = await s.call('ann', 'POST', '/invites', {});
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    // A different member has their own allowance.
    assert.equal((await s.call('bo', 'POST', '/invites', {})).status, 201);
  } finally { await s.close(); }
});

test('member search is rate limited', async () => {
  const s = await setup({ rateLimits: { search: { max: 2, windowMs: 60000 } } });
  try {
    await s.call('ann', 'GET', '/me');
    assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 200);
    assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 200);
    assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 429);
  } finally { await s.close(); }
});

test('contributions: the funding cap holds when many arrive at once', async () => {
  const s = await setup();
  try {
    const lenders = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];
    const id = await openRequest(s, 50000, lenders); // $500
    const results = await Promise.all(lenders.map((l) =>
      s.call(l, 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 100 })));
    const accepted = results.filter((r) => r.status === 201).length;
    assert.equal(accepted, 5, 'exactly five $100 contributions fit in $500');
    const total = s.repo._state.contributions.filter((c) => c.requestId === id).reduce((t, c) => t + c.amountCents, 0);
    assert.equal(total, 50000);
    assert.equal(s.repo._state.requests.get(id).status, 'funded');
  } finally { await s.close(); }
});

test('contributions: a retry with the same Idempotency-Key records once', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s, 50000, ['lee']);
    const headers = { 'Idempotency-Key': 'lee-retry-0001' };
    const first = await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 120 }, headers);
    const retry = await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 120 }, headers);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200, 'the retry returns the original result, not a new contribution');
    assert.equal(s.repo._state.contributions.filter((c) => c.requestId === id).length, 1);
    assert.equal(retry.body.request.raisedCents, 12000);
  } finally { await s.close(); }
});

test('contributions: a malformed Idempotency-Key is rejected', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s, 50000, ['lee']);
    const r = await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 10 },
      { 'Idempotency-Key': 'has spaces!' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, undefined); // the header is not a form field
  } finally { await s.close(); }
});

test('contributions: own-request and cap rules still apply with the atomic path', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s, 10000, ['lee']);
    assert.equal((await s.call('ann', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 10 })).status, 409);
    const over = await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 200 });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /Only 10000 cents remain/);
  } finally { await s.close(); }
});

test('delete account: removes personal data, deletes the sign-in identity, keeps the money record', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s, 10000, ['lee']);
    await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 100 });
    await s.call('lee', 'POST', '/follows', { userId: (await s.call('ann', 'GET', '/me')).body.user.id });
    const lee = (await s.call('lee', 'GET', '/me')).body.user;
    s.repo._state.requests.get(id).status = 'repaid'; // nothing left owing, so deletion is allowed

    const r = await s.call('lee', 'DELETE', '/me');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.deleted, ['clerk_lee']);

    const stored = s.repo._state.users.get(lee.id);
    assert.equal(stored.name, 'Deleted member');
    assert.equal(stored.email, `deleted-${lee.id}@deleted.invalid`);
    assert.equal(stored.phone, null);
    assert.equal(s.repo._state.follows.some((f) => f.followerId === lee.id || f.followeeId === lee.id), false);
    // The contribution row stays, so the request's totals are unchanged.
    assert.equal(s.repo._state.contributions.filter((c) => c.contributorId === lee.id).length, 1);

    // Signing in again with the deleted identity creates a fresh member, not the old record.
    const again = await s.call('lee', 'GET', '/me');
    assert.notEqual(again.body.user.id, lee.id);
    assert.equal(again.body.user.name, 'lee');
  } finally { await s.close(); }
});

test('delete account: blocked while the member owes on an open or funded request', async () => {
  const s = await setup();
  try {
    await openRequest(s); // ann is the borrower of an open request
    const blocked = await s.call('ann', 'DELETE', '/me');
    assert.equal(blocked.status, 409);
    assert.deepEqual(s.deleted, [], 'the identity is untouched when deletion is refused');
    assert.equal(s.repo._state.users.get((await s.call('ann', 'GET', '/me')).body.user.id).name, 'ann');
  } finally { await s.close(); }
});

test('delete account: a failed identity deletion leaves the member unchanged', async () => {
  const s = await setup({ deleteIdentity: async () => { throw new Error('clerk down'); } });
  try {
    await s.call('kim', 'GET', '/me');
    const r = await s.call('kim', 'DELETE', '/me');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Something went wrong');
    const kim = [...s.repo._state.users.values()].find((u) => u.name === 'kim');
    assert.equal(kim.name, 'kim', 'nothing was anonymised, so the member can retry');
  } finally { await s.close(); }
});

test('privacy policy is published and linked from the profile with a delete action', () => {
  const pub = path.join(__dirname, '..', 'public');
  const policy = fs.readFileSync(path.join(pub, 'privacy.html'), 'utf8');
  assert.match(policy, /Delete my account/);
  assert.match(policy, /Clerk/);
  const page = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.match(page, /id="delete-account"/);
  assert.match(page, /href="\/privacy\.html"/);
});
