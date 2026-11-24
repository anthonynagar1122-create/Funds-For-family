'use strict';
// GET /api/verification-queue: the verifier's to-do list of requests awaiting a decision.
const test = require('node:test');
const assert = require('node:assert/strict');
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
  return { repo, call, me, close: () => new Promise((res) => server.close(res)) };
}

const req = (nomineeId, purpose = 'School fees for the second term at the local college') =>
  ({ amount: 500, purpose, repaymentDate: '2027-02-01', nomineeId });

test('verification queue: non-verifiers are refused', async () => {
  const { call, me, close } = await setup();
  try {
    await me('ann');
    const r = await call('ann', 'GET', '/verification-queue');
    assert.equal(r.status, 403);
  } finally { await close(); }
});

test('verification queue: lists pending requests a verifier may decide, oldest first', async () => {
  const { repo, call, me, close } = await setup();
  try {
    const ann = await me('ann'); const nat = await me('nat'); const vee = await me('vee'); const bob = await me('bob');
    await repo.setVerifier(vee.id, true);
    const first = (await call('ann', 'POST', '/requests', req(nat.id))).body.request.id;
    const second = (await call('bob', 'POST', '/requests', req(nat.id, 'Repair the family scooter before the monsoon'))).body.request.id;
    const r = await call('vee', 'GET', '/verification-queue');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.requests.map((x) => x.id), [first, second]);
    assert.equal(r.body.requests[0].status, 'pending_verification');
    assert.ok(ann.id && bob.id);
  } finally { await close(); }
});

test('verification queue: excludes own, nominee, already-decided and no-longer-pending requests', async () => {
  const { repo, call, me, close } = await setup();
  try {
    const ann = await me('ann'); const vee = await me('vee'); const wes = await me('wes');
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);
    const own = (await call('vee', 'POST', '/requests', req(ann.id))).body.request.id;
    const asNominee = (await call('ann', 'POST', '/requests', req(vee.id))).body.request.id;
    const decided = (await call('ann', 'POST', '/requests', req(wes.id, 'Medical bills after a hospital visit last week'))).body.request.id;
    await call('vee', 'POST', `/requests/${decided}/verify`, { decision: 'approve' });
    const nia = await me('nia');
    const rejected = (await call('wes', 'POST', '/requests', req(nia.id, 'Rent shortfall for the month of December'))).body.request.id;
    await repo.setVerifier(ann.id, true);
    const rej = await call('ann', 'POST', `/requests/${rejected}/verify`, { decision: 'reject' });
    assert.equal(rej.body.request.status, 'rejected');
    const r = await call('vee', 'GET', '/verification-queue');
    const ids = r.body.requests.map((x) => x.id);
    for (const id of [own, asNominee, decided, rejected]) assert.ok(!ids.includes(id), `request ${id} should be excluded`);
  } finally { await close(); }
});
