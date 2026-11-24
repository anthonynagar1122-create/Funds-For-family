'use strict';
// Fixes from the final whole-branch review of Phase A.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../src/rules');
const { createMemoryRepo } = require('../src/memory-repo');
const { createSupabaseRepo } = require('../src/supabase-repo');
const { identityFromClerkUser } = require('../src/services');
const invitesLib = require('../src/invites');
const { setup } = require('./helpers/harness');
const { connect, startRequest, idOf, lend } = require('./helpers/lifecycle');

const NO_EMAIL = { 'x-test-no-email': '1' };
const clerkUser = (status, extra = {}) => ({
  id: 'user_1', firstName: 'Ann', lastName: 'Rao', imageUrl: 'http://img',
  primaryEmailAddress: { emailAddress: 'Ann@Example.com', verification: status ? { status } : null }, ...extra,
});

// ---- 1. unverified Clerk email ----
test('identityFromClerkUser keeps a verified email and drops an unverified one', () => {
  assert.equal(identityFromClerkUser(clerkUser('verified')).email, 'Ann@Example.com');
  assert.equal(identityFromClerkUser(clerkUser('unverified')).email, null);
  assert.equal(identityFromClerkUser(clerkUser(null)).email, null);
  assert.equal(identityFromClerkUser(clerkUser('verified', { primaryEmailAddress: null })).email, null);
  const id = identityFromClerkUser(clerkUser('unverified'));
  assert.equal(id.clerkId, 'user_1');
  assert.equal(id.name, 'Ann Rao');
});

test('an identity without a verified email is never admitted as owner or by an email invite', async () => {
  const { repo, call, close } = await setup({ admitAll: false, ownerEmail: 'boss@example.com' });
  try {
    const owner = await call('boss', 'GET', '/me', undefined, undefined, NO_EMAIL);
    assert.equal(owner.status, 403);
    assert.equal(owner.body.code, 'invite_only');
    assert.equal(await repo.findUserByClerkId('clerk_boss'), null);

    const inviter = await repo.createUser({ clerkId: 'clerk_inv', name: 'Inv', email: 'inv@example.com' });
    await repo.createInvite({ inviterId: inviter.id, email: 'new@example.com', tokenHash: 'h1',
      expiresAt: new Date('2027-01-01').toISOString(), createdAt: '2026-11-20T00:00:00Z' });
    const byEmail = await call('new', 'GET', '/me', undefined, undefined, NO_EMAIL);
    assert.equal(byEmail.status, 403);
    // The verified owner is still admitted.
    const ok = await call('boss', 'GET', '/me', undefined, undefined, { 'x-test-email': 'boss@example.com' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.isAdmin, true);
  } finally { await close(); }
});

test('an invite token with no verified email cannot create a member (the database needs an email)', async () => {
  const { repo, call, close } = await setup({ admitAll: false });
  try {
    const inviter = await repo.createUser({ clerkId: 'clerk_inv', name: 'Inv', email: 'inv@example.com' });
    const { token, tokenHash } = invitesLib.newToken();
    await repo.createInvite({ inviterId: inviter.id, email: 'x@example.com', tokenHash,
      expiresAt: new Date('2027-01-01').toISOString(), createdAt: '2026-11-20T00:00:00Z' });
    const r = await call('new', 'GET', '/me', undefined, undefined, { ...NO_EMAIL, 'x-invite-token': token });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'email_unverified');
    assert.equal((await repo.findInviteByHash(tokenHash)).acceptedAt, null, 'the invite is still usable');
  } finally { await close(); }
});

// ---- 2. double-submitted request ----
test('a duplicate-active-request database error (23505) becomes a 409, not a 500', async () => {
  const inner = createMemoryRepo();
  const repo = { ...inner, createRequest: async () => { throw Object.assign(new Error('dup'), { code: '23505' }); } };
  const { call, close } = await setup({ repo });
  try {
    await connect(call, 'ann', 'ben');
    const r = await call('ann', 'POST', '/requests', {
      amount: 500, purpose: 'School fees for the second term at the local college',
      repaymentDate: '2027-02-01', category: 'education', trustedContactId: await idOf(call, 'ben'),
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'You already have an active request. Finish or withdraw it first.');
    assert.equal(r.body.field, undefined);
    // Other errors are still 500.
    repo.createRequest = async () => { throw new Error('boom'); };
    const r2 = await call('ann', 'POST', '/requests', {
      amount: 500, purpose: 'School fees for the second term at the local college',
      repaymentDate: '2027-02-01', category: 'education', trustedContactId: await idOf(call, 'ben'),
    });
    assert.equal(r2.status, 500);
  } finally { await close(); }
});

test('the Supabase repo keeps the PostgREST code and details on errors', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    code: '23505', message: 'duplicate key value violates unique constraint', details: 'Key (borrower_id) already exists.', hint: null,
  }), { status: 409, headers: { 'content-type': 'application/json' } });
  const repo = createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: fakeFetch });
  await assert.rejects(() => repo.createRequest({
    borrowerId: 1, trustedContactId: 2, purpose: 'x'.repeat(30), principalCents: 20000, repaymentDate: '2027-03-01',
  }), (err) => err.code === '23505' && /already exists/.test(err.details) && /Supabase:/.test(err.message));
});

// ---- 3. cap races ----
test('exceedsCapAtRow: running sent+confirmed total in id order, not_received ignored', () => {
  const e = (id, amountCents, status) => ({ id, amountCents, status });
  const rows = [e(5, 300, 'sent'), e(2, 400, 'confirmed'), e(3, 900, 'not_received'), e(9, 200, 'sent')];
  assert.equal(rules.exceedsCapAtRow(rows, 5, 700), false);   // 400 + 300 = 700
  assert.equal(rules.exceedsCapAtRow(rows, 5, 699), true);
  assert.equal(rules.exceedsCapAtRow(rows, 9, 800), true);    // 900 > 800
  assert.equal(rules.exceedsCapAtRow(rows, 9, 900), false);
  assert.equal(rules.exceedsCapAtRow(rows, 2, 400), false);
  assert.equal(rules.exceedsCapAtRow(rows, 3, 1), false, 'a not_received row is not counted');
  assert.equal(rules.exceedsCapAtRow(rows, 404, 1), false, 'unknown row');
});

test('isFullyRepaid treats an over-repaid lender (owed <= 0) as settled', () => {
  const m = rules.owedByLender([{ lenderId: 7, amountCents: 100, status: 'confirmed' }], [{ lenderId: 7, amountCents: 150, status: 'confirmed' }]);
  assert.equal(rules.isFullyRepaid(m), true);
  assert.equal(rules.isFullyRepaid(new Map()), false);
});

// A repo wrapper that lets a competing request slip in between the check and the write.
function racingRepo(inner, hooks) {
  return { ...inner, ...Object.fromEntries(Object.entries(hooks).map(([name, make]) => [name, make(inner)])) };
}

async function openRequest(call, repo) {
  const id = await startRequest(call, 'ann', 'cat');
  for (const v of ['vee', 'wes']) {
    await call(v, 'GET', '/me');
    await repo.setVerifier((await repo.findUserByClerkId(`clerk_${v}`)).id, true);
    await call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  }
  return id;
}

test('a contribution that loses a cap race is removed and answered 409', async () => {
  const inner = createMemoryRepo();
  let competitor = null;
  const repo = racingRepo(inner, {
    addContribution: (r) => async (row) => {
      if (competitor) { const c = competitor; competitor = null; await r.addContribution(c); }
      return r.addContribution(row);
    },
  });
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, inner);
    await connect(call, 'lee', 'ann');
    await connect(call, 'mo', 'ann');
    const lee = await idOf(call, 'lee'); const mo = await idOf(call, 'mo');
    competitor = { requestId: id, contributorId: mo, amountCents: 40000, status: 'sent', createdAt: '2026-11-20T12:00:00Z' };
    const r = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 300 }); // 500 total cap, 400 slipped in first
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /Only .* is still needed/);
    const rows = await inner.listContributions(id);
    assert.deepEqual(rows.map((x) => x.contributorId), [mo], 'no row is left behind for the loser');
    assert.ok(lee);
  } finally { await close(); }
});

test('a contribution correction that loses a cap race goes back to not_received with its old amount', async () => {
  const inner = createMemoryRepo();
  let before = null;
  const repo = racingRepo(inner, {
    updateContribution: (r) => async (id, patch) => {
      if (before && patch.status === 'sent') { const f = before; before = null; await f(); }
      return r.updateContribution(id, patch);
    },
  });
  const { call, close } = await setup({ repo });
  try {
    const id = await openRequest(call, inner);
    await connect(call, 'lee', 'ann');
    await connect(call, 'mo', 'ann');
    const lee = await idOf(call, 'lee'); const mo = await idOf(call, 'mo');
    const mk = (contributorId, amountCents) => inner.addContribution({ requestId: id, contributorId, amountCents, status: 'not_received', utr: null, createdAt: '2026-11-20T12:00:00Z' });
    const a = await mk(lee, 10000); const b = await mk(mo, 10000);
    // Both correct to 30000 (cap 50000). Lee's correction lands first, in the gap after mo's check.
    before = () => inner.updateContribution(a.id, { status: 'sent', amountCents: 30000 });
    const r = await call('mo', 'PATCH', `/contributions/${b.id}`, { amount: 300 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /Only .* is still needed/);
    const back = await inner.getContribution(b.id);
    assert.equal(back.status, 'not_received');
    assert.equal(back.amountCents, 10000);
    assert.equal((await inner.getContribution(a.id)).status, 'sent', 'the earlier row keeps its place');
  } finally { await close(); }
});

test('a new contribution is refused and leaves no row when the request is already over its cap', async () => {
  const inner = createMemoryRepo();
  const { call, close } = await setup({ repo: inner });
  try {
    const id = await openRequest(call, inner);
    await connect(call, 'lee', 'ann');
    const mo = await idOf(call, 'ann');
    await inner.addContribution({ requestId: id, contributorId: mo, amountCents: 60000, status: 'sent', createdAt: '2026-11-20T12:00:00Z' });
    const r = await call('lee', 'POST', `/requests/${id}/contributions`, { amount: 100 });
    assert.equal(r.status, 409);
    assert.equal((await inner.listContributions(id)).length, 1);
  } finally { await close(); }
});

// ---- repayments ----
async function fundedRequest(call, repo, amounts) {
  const id = await openRequest(call, repo);
  const lenders = Object.keys(amounts);
  for (const l of lenders) {
    await connect(call, l, 'ann');
    await lend(call, l, 'ann', id, amounts[l]);
  }
  const closed = await call('ann', 'POST', `/requests/${id}/close`);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  return id;
}

test('a repayment that loses a cap race is removed and answered 409', async () => {
  const inner = createMemoryRepo();
  let before = null;
  const repo = racingRepo(inner, {
    addRepayment: (r) => async (row) => {
      if (before) { const f = before; before = null; await f(); }
      return r.addRepayment(row);
    },
  });
  const { call, close } = await setup({ repo });
  try {
    const id = await fundedRequest(call, inner, { lee: 200 });
    const lee = await idOf(call, 'lee'); const ann = await idOf(call, 'ann'); const cat = await idOf(call, 'cat');
    before = () => inner.addRepayment({ requestId: id, payerId: cat, lenderId: lee, amountCents: 15000, status: 'sent', createdAt: '2026-11-20T12:00:00Z' });
    const r = await call('ann', 'POST', `/requests/${id}/repayments`, { lenderId: lee, amount: 100 }); // owed 200, 150 slipped in
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /can still be repaid/);
    assert.deepEqual((await inner.listRepayments(id)).map((x) => x.payerId), [cat], 'no row left for the loser');
    assert.ok(ann);
  } finally { await close(); }
});

test('a repayment correction that loses a cap race goes back to not_received with its old amount', async () => {
  const inner = createMemoryRepo();
  let before = null;
  const repo = racingRepo(inner, {
    updateRepayment: (r) => async (id, patch) => {
      if (before && patch.status === 'sent') { const f = before; before = null; await f(); }
      return r.updateRepayment(id, patch);
    },
  });
  const { call, close } = await setup({ repo });
  try {
    const id = await fundedRequest(call, inner, { lee: 200 });
    const lee = await idOf(call, 'lee'); const ann = await idOf(call, 'ann'); const cat = await idOf(call, 'cat');
    const mk = (payerId, amountCents) => inner.addRepayment({ requestId: id, payerId, lenderId: lee, amountCents, status: 'not_received', createdAt: '2026-11-20T12:00:00Z' });
    const a = await mk(cat, 5000); const b = await mk(ann, 5000);
    before = () => inner.updateRepayment(a.id, { status: 'sent', amountCents: 15000 });
    const r = await call('ann', 'PATCH', `/repayments/${b.id}`, { amount: 100 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    const back = await inner.getRepayment(b.id);
    assert.equal(back.status, 'not_received');
    assert.equal(back.amountCents, 5000);
    assert.equal((await inner.getRepayment(a.id)).status, 'sent');
  } finally { await close(); }
});

// ---- 4a. legacy repayments without a lender ----
test('owedByLender skips entries with no lender id', () => {
  const m = rules.owedByLender(
    [{ lenderId: 7, amountCents: 100, status: 'confirmed' }, { lenderId: null, amountCents: 50, status: 'confirmed' }],
    [{ lenderId: null, amountCents: 30, status: 'confirmed' }, { amountCents: 5, status: 'sent' }, { lenderId: 7, amountCents: 100, status: 'confirmed' }],
  );
  assert.deepEqual([...m.keys()], [7]);
  assert.equal(rules.isFullyRepaid(m), true);
});

test('a legacy confirmed repayment with no lender does not block repayment or reach getUsers as null', async () => {
  const inner = createMemoryRepo();
  const asked = [];
  const repo = { ...inner, getUsers: async (ids) => { asked.push(ids); return inner.getUsers(ids); } };
  const { call, close } = await setup({ repo });
  try {
    const id = await fundedRequest(call, inner, { lee: 200 });
    const lee = await idOf(call, 'lee'); const ann = await idOf(call, 'ann');
    await inner.addRepayment({ requestId: id, payerId: ann, lenderId: null, amountCents: 7000, status: 'confirmed', createdAt: '2026-01-01T00:00:00Z' });
    const d = await call('ann', 'GET', `/requests/${id}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.request.lenders.map((l) => l.userId), [lee]);
    assert.ok(asked.every((ids) => ids.every((x) => x !== null && x !== undefined)), 'no null id asked for');
    const rep = await call('ann', 'POST', `/requests/${id}/repayments`, { lenderId: lee, amount: 200 });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    const done = await call('lee', 'POST', `/repayments/${rep.body.repayment.id}/confirm`);
    assert.equal(done.status, 200);
    assert.equal(done.body.request.status, 'repaid');
  } finally { await close(); }
});

// ---- 4b. confirm retry completes the transition ----
test('confirming an already-confirmed contribution still completes a missed funded transition', async () => {
  const inner = createMemoryRepo();
  const { call, close } = await setup({ repo: inner });
  try {
    const id = await openRequest(call, inner);
    await connect(call, 'lee', 'ann');
    const cid = await lend(call, 'lee', 'ann', id, 500);
    assert.equal((await inner.getRequest(id)).status, 'funded');
    await inner.updateRequest(id, { status: 'open', fundedAt: null, fundedCents: null }); // the update failed the first time
    const again = await call('ann', 'POST', `/contributions/${cid}/confirm`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await inner.getRequest(id)).status, 'funded');
    assert.equal(again.body.request.status, 'funded');
  } finally { await close(); }
});

test('confirming an already-confirmed repayment still completes a missed repaid transition', async () => {
  const inner = createMemoryRepo();
  const { call, close } = await setup({ repo: inner });
  try {
    const id = await fundedRequest(call, inner, { lee: 200 });
    const lee = await idOf(call, 'lee');
    const rep = await call('ann', 'POST', `/requests/${id}/repayments`, { lenderId: lee, amount: 200 });
    const pid = rep.body.repayment.id;
    assert.equal((await call('lee', 'POST', `/repayments/${pid}/confirm`)).status, 200);
    assert.equal((await inner.getRequest(id)).status, 'repaid');
    await inner.updateRequest(id, { status: 'funded', repaidAt: null });
    const again = await call('lee', 'POST', `/repayments/${pid}/confirm`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await inner.getRequest(id)).status, 'repaid');
  } finally { await close(); }
});

// ---- 4c. migrations are transactional ----
test('migrations 0002 and 0003 run inside a transaction', () => {
  for (const f of ['0002_customer_ready.sql', '0003_fix_upi_check.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', f), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l) && l.trim()).map((l) => l.trim().toLowerCase());
    assert.equal(sql[0], 'begin;', f);
    assert.equal(sql.at(-1), 'commit;', f);
  }
});

// ---- 5. atomic invite claim ----
test('a concurrent invite claim that loses is refused and creates no member', async () => {
  const inner = createMemoryRepo();
  const repo = { ...inner, claimInvite: async (id, p) => { await inner.claimInvite(id, { acceptedAt: p.acceptedAt }); return inner.claimInvite(id, p); } };
  const { call, close } = await setup({ repo, admitAll: false });
  try {
    const inviter = await inner.createUser({ clerkId: 'clerk_inv', name: 'Inv', email: 'inv@example.com' });
    const { token, tokenHash } = invitesLib.newToken();
    await inner.createInvite({ inviterId: inviter.id, email: 'x@example.com', tokenHash,
      expiresAt: new Date('2027-01-01').toISOString(), createdAt: '2026-11-20T00:00:00Z' });
    const r = await call('new', 'GET', '/me', undefined, undefined, { 'x-invite-token': token });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'invite_only');
    assert.equal(await inner.findUserByClerkId('clerk_new'), null);
  } finally { await close(); }
});

test('accepting an invite records the accepted user and follows the inviter both ways', async () => {
  const inner = createMemoryRepo();
  const { call, close } = await setup({ repo: inner, admitAll: false });
  try {
    const inviter = await inner.createUser({ clerkId: 'clerk_inv', name: 'Inv', email: 'inv@example.com' });
    const { token, tokenHash } = invitesLib.newToken();
    const inv = await inner.createInvite({ inviterId: inviter.id, email: 'x@example.com', tokenHash,
      expiresAt: new Date('2027-01-01').toISOString(), createdAt: '2026-11-20T00:00:00Z' });
    const r = await call('new', 'GET', '/me', undefined, undefined, { 'x-invite-token': token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await inner.getInvite(inv.id);
    assert.equal(after.acceptedUserId, r.body.user.id);
    assert.ok(after.acceptedAt);
    const conn = await inner.connections(inviter.id);
    assert.deepEqual(conn.following, [r.body.user.id]);
    assert.deepEqual(conn.followers, [r.body.user.id]);
  } finally { await close(); }
});

// ---- 6. existing owner row becomes admin ----
test('an existing member whose verified email is the owner email is promoted once', async () => {
  const repo = createMemoryRepo();
  const { call, close } = await setup({ repo, ownerEmail: 'Boss@Example.com' });
  try {
    await repo.createUser({ clerkId: 'clerk_boss', name: 'Boss', email: 'boss@example.com', isAdmin: false, isVerifier: false });
    const unverified = await call('boss', 'GET', '/me', undefined, undefined, NO_EMAIL);
    assert.equal(unverified.status, 200);
    assert.equal(unverified.body.user.isAdmin, false, 'an unverified email does not promote');
    const r = await call('boss', 'GET', '/me', undefined, undefined, { 'x-test-email': 'boss@example.com' });
    assert.equal(r.body.user.isAdmin, true);
    assert.equal((await repo.findUserByClerkId('clerk_boss')).isVerifier, true);
    const other = await repo.createUser({ clerkId: 'clerk_other', name: 'Other', email: 'other@example.com' });
    await call('other', 'GET', '/me');
    assert.equal((await repo.getUser(other.id)).isAdmin, false);
  } finally { await close(); }
});

// ---- 7. cannot repay yourself ----
test('checkRepayment rejects a payer who is also the lender', () => {
  const owed = { lentCents: 1000, repaidCents: 0, pendingRepayCents: 0, owedCents: 1000 };
  const base = { amountCents: 100, payerId: 3, borrowerId: 1, trustedContactId: 3, lenderId: 3, owed, status: 'funded' };
  const res = rules.checkRepayment(base);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'You cannot repay yourself');
  assert.equal(rules.checkRepayment({ ...base, lenderId: 4 }).ok, true);
});

test('a trusted contact who also lent cannot record a repayment to themselves', async () => {
  const inner = createMemoryRepo();
  const { call, close } = await setup({ repo: inner });
  try {
    const id = await openRequest(call, inner);
    await connect(call, 'cat', 'ann');
    await lend(call, 'cat', 'ann', id, 200);
    await call('ann', 'POST', `/requests/${id}/close`);
    const cat = await idOf(call, 'cat');
    const r = await call('cat', 'POST', `/requests/${id}/repayments`, { lenderId: cat, amount: 100 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'You cannot repay yourself');
  } finally { await close(); }
});

// ---- 8. non-numeric ids ----
test('non-integer path ids are 404 and never reach the database', async () => {
  const inner = createMemoryRepo();
  const strict = (fn) => async (id, ...rest) => {
    if (!Number.isSafeInteger(id)) throw new Error(`bad id reached the repo: ${String(id)}`);
    return inner[fn](id, ...rest);
  };
  const repo = { ...inner };
  for (const fn of ['getUser', 'getInvite', 'getRequest', 'getContribution', 'getRepayment']) repo[fn] = strict(fn);
  repo.removeFollow = async (a, b) => strict('removeFollow')(b, a);
  const { call, close } = await setup({ repo });
  try {
    await call('ann', 'GET', '/me');
    const bad = ['abc', '1.5', '-1', '1e3', '99999999999999999999'];
    for (const b of bad) {
      for (const [m, p] of [['GET', `/users/${b}`], ['DELETE', `/follows/${b}`], ['DELETE', `/invites/${b}`], ['GET', `/requests/${b}`],
        ['POST', `/contributions/${b}/confirm`], ['PATCH', `/contributions/${b}`], ['DELETE', `/contributions/${b}`],
        ['POST', `/repayments/${b}/confirm`], ['PATCH', `/repayments/${b}`], ['DELETE', `/repayments/${b}`]]) {
        const r = await call('ann', m, p, m === 'GET' || m === 'DELETE' ? undefined : {});
        assert.equal(r.status, 404, `${m} ${p} -> ${r.status} ${r.text}`);
      }
    }
  } finally { await close(); }
});
