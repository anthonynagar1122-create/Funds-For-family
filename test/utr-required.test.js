'use strict';
// A payment is marked "sent" only with a UPI reference (UTR). A UTR identifies one bank transfer, so it is
// recorded at most once per request (case-insensitive), across contributions and repayments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { createMemoryRepo } = require('../src/memory-repo');
const { startRequest, connect, idOf } = require('./helpers/lifecycle');

const TAKEN = 'This UPI reference is already recorded on this request';
const REQUIRED = 'Enter the UPI reference (UTR) from your payment: 6 to 35 letters or digits';

// Two verifiers approve the request, so it is open for funding. Returns the request id.
async function openRequest(call, repo, borrower = 'ann', contact = 'cat') {
  const id = await startRequest(call, borrower, contact);
  for (const v of ['vee', 'wes']) {
    await call(v, 'GET', '/me');
    await repo.setVerifier((await repo.findUserByClerkId(`clerk_${v}`)).id, true);
    await call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  }
  return id;
}

// Put a funded request in repayment: lee lends the full amount and the borrower closes the round.
async function fundedRequest(call, repo, amount = 500) {
  const id = await openRequest(call, repo);
  await connect(call, 'lee', 'ann');
  const sent = await call('lee', 'POST', `/requests/${id}/contributions`, { amount, utr: 'FUNDUTR001' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  await call('ann', 'POST', `/contributions/${sent.body.contribution.id}/confirm`);
  return id;
}

test('a contribution without a UTR is refused and nothing is recorded', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    const r = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300, utr: '' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'utr');
    assert.equal(r.body.error, REQUIRED);
    assert.equal((await repo.listContributions(id)).length, 0);
  } finally { await close(); }
});

test('a malformed UTR is refused on the utr field', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    const r = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300, utr: 'ab-12' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'utr');
  } finally { await close(); }
});

test('the same UTR cannot be recorded twice on one request, in any letter case', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    await connect(call, 'mo', 'ann');
    const first = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300, utr: 'abcd1234' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call('mo', 'POST', `/requests/${id}/contributions`, { amount: 100, utr: 'ABCD1234' });
    assert.equal(again.status, 409);
    assert.equal(again.body.field, 'utr');
    assert.equal(again.body.error, TAKEN);
    assert.equal((await repo.listContributions(id)).length, 1);
  } finally { await close(); }
});

test('a UTR used on a contribution cannot be reused for a repayment on the same request', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await fundedRequest(call, repo, 500);
    // The contribution above used FUNDUTR001; a repayment with that reference is refused.
    const r = await call('ann', 'POST', `/requests/${id}/repayments`, { lenderId: await idOf(call, 'lee'), amount: 100, utr: 'fundutr001' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, TAKEN);
    assert.equal((await repo.listRepayments(id)).length, 0);
  } finally { await close(); }
});

test('the same UTR may be used on a different request', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const first = await openRequest(call, repo, 'ann', 'cat');
    const second = await openRequest(call, repo, 'dan', 'eve');
    await connect(call, 'lee', 'ann');
    await connect(call, 'lee', 'dan');
    const a = await call('lee', 'POST', `/requests/${first}/contributions`, { amount: 300, utr: 'SAMEUTR123' });
    const b = await call('lee', 'POST', `/requests/${second}/contributions`, { amount: 300, utr: 'SAMEUTR123' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
  } finally { await close(); }
});

test('a correction with no UTR left is refused, and a correction may keep its own UTR', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    // A legacy entry with no UTR, already marked not received.
    const legacy = await repo.addContribution({ requestId: id, contributorId: await idOf(call, 'lee'), amountCents: 30000, status: 'not_received', utr: null, createdAt: '2026-11-20T12:00:00Z' });
    const noUtr = await call('lee', 'PATCH', `/contributions/${legacy.id}`, { amount: 250 });
    assert.equal(noUtr.status, 400);
    assert.equal(noUtr.body.field, 'utr');

    const mine = await repo.addContribution({ requestId: id, contributorId: await idOf(call, 'lee'), amountCents: 10000, status: 'not_received', utr: 'OWNUTR0001', createdAt: '2026-11-20T12:00:00Z' });
    const keep = await call('lee', 'PATCH', `/contributions/${mine.id}`, { amount: 250 });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(keep.body.contribution.utr, 'OWNUTR0001');
  } finally { await close(); }
});

test('a correction cannot take a UTR another entry on the request already uses', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    await connect(call, 'mo', 'ann');
    await repo.addContribution({ requestId: id, contributorId: await idOf(call, 'mo'), amountCents: 10000, status: 'sent', utr: 'TAKENUTR01', createdAt: '2026-11-20T12:00:00Z' });
    const mine = await repo.addContribution({ requestId: id, contributorId: await idOf(call, 'lee'), amountCents: 10000, status: 'not_received', utr: 'OLDUTR0001', createdAt: '2026-11-20T12:00:00Z' });
    const r = await call('lee', 'PATCH', `/contributions/${mine.id}`, { utr: 'takenutr01' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, TAKEN);
    assert.equal((await repo.getContribution(mine.id)).status, 'not_received', 'a refused correction leaves the entry alone');
  } finally { await close(); }
});

test('a UTR clash caught by the database is reported as a duplicate, not a server error', async () => {
  const inner = createMemoryRepo();
  const repo = { ...inner, recordContribution: async () => { throw Object.assign(new Error('Supabase: duplicate key'), { code: '23505' }); } };
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, repo);
    await connect(call, 'lee', 'ann');
    const r = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300, utr: 'RACEUTR001' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, TAKEN);
  } finally { await close(); }
});
