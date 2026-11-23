'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');

// Fixed clock so date rules are deterministic.


const EMPTY = { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { nominee: [], verifier: [] } };

// Ann borrows. Nat, Lee, Vee and Wes are connected to Ann (follow her), so the ledger can see her requests.
// Vee and Wes are verifiers. Sam has no connections.
async function community({ repo, call }) {
  const ids = {};
  for (const name of ['ann', 'nat', 'lee', 'vee', 'wes', 'sam']) {
    ids[name] = (await call(name, 'GET', '/me')).body.user.id;
  }
  await repo.setVerifier(ids.vee, true);
  await repo.setVerifier(ids.wes, true);
  for (const name of ['nat', 'lee', 'vee', 'wes']) {
    await call(name, 'POST', '/follows', { userId: ids.ann });
  }
  return ids;
}

const validRequest = (nomineeId) => ({
  amount: 500,
  purpose: 'School fees for the second term at the local college',
  repaymentDate: '2027-02-01',
  category: 'education',
  trustedContactId: nomineeId,
});

async function createRequest({ call }, nomineeId) {
  const r = await call('ann', 'POST', '/requests', validRequest(nomineeId));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.request.id;
}

// A request that is open for funding: created by Ann, approved by both verifiers.
async function openRequest(ctx, nomineeId) {
  const id = await createRequest(ctx, nomineeId);
  await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  const done = await ctx.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  assert.equal(done.body.request.status, 'open');
  return id;
}

test('activity is refused without a signed-in member', async () => {
  const { call, close } = await setup();
  try {
    const r = await call(null, 'GET', '/activity');
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('a new member gets empty ledger lists, not an error', async () => {
  const ctx = await setup();
  try {
    await ctx.call('zoe', 'GET', '/me');
    const r = await ctx.call('zoe', 'GET', '/activity');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, EMPTY);
  } finally { await ctx.close(); }
});

test('a borrower sees their request under borrowing', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    const r = await ctx.call('ann', 'GET', '/activity');
    assert.equal(r.status, 200);
    assert.equal(r.body.borrowing.length, 1);
    assert.equal(r.body.borrowing[0].requestId, id);
    assert.equal(r.body.borrowing[0].myRole, 'borrower');
    assert.equal(r.body.borrowing[0].status, 'open');
    assert.equal(r.body.borrowing[0].principalCents, 50000);
  } finally { await ctx.close(); }
});

test('a contributor sees the request under lending with their own total', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    const c = await ctx.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300 });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await ctx.call('lee', 'GET', '/activity');
    assert.equal(r.body.lending.length, 1);
    assert.equal(r.body.lending[0].requestId, id);
    assert.equal(r.body.lending[0].myRole, 'lender');
    assert.equal(r.body.lending[0].myAmountCents, 30000);
    assert.deepEqual(r.body.borrowing, []);
  } finally { await ctx.close(); }
});

test('repayments made and received are split by who recorded them', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    await ctx.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 500 });
    const paid = await ctx.call('nat', 'POST', `/requests/${id}/repayments`, { amount: 100 });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const nat = await ctx.call('nat', 'GET', '/activity');
    assert.equal(nat.body.repayments.made.length, 1);
    assert.equal(nat.body.repayments.made[0].requestId, id);
    assert.equal(nat.body.repayments.made[0].myAmountCents, 10000);
    assert.deepEqual(nat.body.repayments.received, []);

    const lee = await ctx.call('lee', 'GET', '/activity');
    assert.equal(lee.body.repayments.received.length, 1);
    assert.equal(lee.body.repayments.received[0].requestId, id);
    assert.deepEqual(lee.body.repayments.made, []);
  } finally { await ctx.close(); }
});

test('a nominee sees the request under roles.nominee', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    const nat = await ctx.call('nat', 'GET', '/activity');
    assert.equal(nat.body.roles.nominee.length, 1);
    assert.equal(nat.body.roles.nominee[0].requestId, id);
    assert.equal(nat.body.roles.nominee[0].myRole, 'nominee');
    const ann = await ctx.call('ann', 'GET', '/activity');
    assert.deepEqual(ann.body.roles.nominee, []);
  } finally { await ctx.close(); }
});

test('a verifier sees the request under roles.verifier, only when they decided', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await createRequest(ctx, ids.nat);
    await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const vee = await ctx.call('vee', 'GET', '/activity');
    assert.equal(vee.body.roles.verifier.length, 1);
    assert.equal(vee.body.roles.verifier[0].requestId, id);
    assert.equal(vee.body.roles.verifier[0].myRole, 'verifier');
    const wes = await ctx.call('wes', 'GET', '/activity');
    assert.deepEqual(wes.body.roles.verifier, [], 'wes has not decided yet');
  } finally { await ctx.close(); }
});

test('a stranger sees no rows for a request they had no part in', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    await ctx.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 100 });
    const r = await ctx.call('sam', 'GET', '/activity');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, EMPTY);
  } finally { await ctx.close(); }
});

test('ledger rows never include email addresses', async () => {
  const ctx = await setup();
  try {
    const ids = await community(ctx);
    const id = await openRequest(ctx, ids.nat);
    await ctx.call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300 });
    await ctx.call('nat', 'POST', `/requests/${id}/repayments`, { amount: 100 });
    for (const who of ['ann', 'nat', 'lee', 'vee']) {
      const r = await ctx.call(who, 'GET', '/activity');
      const text = JSON.stringify(r.body);
      assert.doesNotMatch(text, /"email"/, `${who} ledger has an email key`);
      assert.doesNotMatch(text, /@example\.com/, `${who} ledger has an email address`);
    }
  } finally { await ctx.close(); }
});

test('a lender sees a loan from a borrower outside their network', async () => {
  const s = await setup();
  try {
    const ids = await community(s);
    const id = (await s.call('ann', 'POST', '/requests', validRequest(ids.nat))).body.request.id;
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    // Sam has no connection to Ann; he is only a lender here.
    const funded = await s.call('sam', 'POST', `/requests/${id}/contributions`, { amount: 100 });
    assert.equal(funded.status, 201);
    const r = await s.call('sam', 'GET', '/activity');
    assert.equal(r.status, 200);
    assert.equal(r.body.lending.length, 1, 'the loan appears in the lender ledger');
    assert.equal(r.body.lending[0].requestId, id);
    assert.equal(r.body.lending[0].myAmountCents, 10000);
  } finally { await s.close(); }
});
