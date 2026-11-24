'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');

const tokenOf = (link) => link.split('#join=')[1];

test('/me exposes welcomedAt, termsAcceptedAt and inviterName for the owner of the profile only', async () => {
  const s = await setup({ admitAll: false, ownerEmail: 'owner@example.com' });
  try {
    const made = await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    const token = tokenOf(made.body.link);
    const me = await s.call('kim', 'GET', '/me', null, null, { 'x-invite-token': token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.welcomedAt, null);
    assert.equal(me.body.user.termsAcceptedAt, null);
    assert.equal(me.body.user.inviterName, 'owner');
    // Another member looking at kim sees none of it.
    const other = await s.call('owner', 'GET', `/users/${me.body.user.id}`);
    assert.equal(other.status, 200);
    for (const k of ['welcomedAt', 'termsAcceptedAt', 'inviterName']) assert.equal(k in other.body.user, false, k);
  } finally { await s.close(); }
});

test('inviterName is null when nobody invited the member', async () => {
  const s = await setup();
  try {
    const me = await s.call('solo', 'GET', '/me');
    assert.equal(me.body.user.inviterName, null);
  } finally { await s.close(); }
});

test('accept-terms and welcomed are idempotent: the first timestamp is kept', async () => {
  const s = await setup();
  try {
    await s.call('asha', 'GET', '/me');
    const t1 = (await s.call('asha', 'POST', '/me/accept-terms')).body.user.termsAcceptedAt;
    assert.ok(t1);
    s.setNow(new Date('2026-11-21T12:00:00Z'));
    const t2 = (await s.call('asha', 'POST', '/me/accept-terms')).body.user.termsAcceptedAt;
    assert.equal(t2, t1);
    const w1 = (await s.call('asha', 'POST', '/me/welcomed')).body.user.welcomedAt;
    assert.ok(w1);
    s.setNow(new Date('2026-11-22T12:00:00Z'));
    const w2 = (await s.call('asha', 'POST', '/me/welcomed')).body.user.welcomedAt;
    assert.equal(w2, w1);
    const me = (await s.call('asha', 'GET', '/me')).body.user;
    assert.equal(me.termsAcceptedAt, t1);
    assert.equal(me.welcomedAt, w1);
  } finally { await s.close(); }
});

test('PATCH /me with an invalid UPI returns 400 on field upiId', async () => {
  const s = await setup();
  try {
    const r = await s.call('asha', 'PATCH', '/me', { upiId: 'not a upi' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'upiId');
  } finally { await s.close(); }
});

test('PATCH /me clears the UPI ID when upiId is null or an empty string', async () => {
  const s = await setup();
  try {
    await s.call('asha', 'GET', '/me');
    for (const clear of [null, '', '   ']) {
      const set = await s.call('asha', 'PATCH', '/me', { upiId: 'asha@okbank' });
      assert.equal(set.body.user.upiId, 'asha@okbank');
      const r = await s.call('asha', 'PATCH', '/me', { upiId: clear });
      assert.equal(r.status, 200, JSON.stringify(clear));
      assert.equal(r.body.user.upiId, null);
      assert.equal((await s.call('asha', 'GET', '/me')).body.user.upiId, null);
    }
    // Other non-string values are still rejected.
    const bad = await s.call('asha', 'PATCH', '/me', { upiId: 42 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'upiId');
  } finally { await s.close(); }
});

// ---- Task 8: email preferences, trust, statement, account deletion ----
const { idOf, connect, startRequest, lend } = require('./helpers/lifecycle');

test('PATCH /me/email-preferences takes two booleans only and /me reports them', async () => {
  const s = await setup();
  try {
    const first = await s.call('asha', 'GET', '/me');
    assert.equal(first.body.user.emailReminders, true);
    assert.equal(first.body.user.emailThanks, true);
    for (const bad of [{}, { reminders: 'yes', thanks: true }, { reminders: true }, { reminders: true, thanks: 1 }, { reminders: null, thanks: false }]) {
      const r = await s.call('asha', 'PATCH', '/me/email-preferences', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const ok = await s.call('asha', 'PATCH', '/me/email-preferences', { reminders: false, thanks: true, essential: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.emailReminders, false);
    assert.equal(ok.body.user.emailThanks, true);
    assert.equal((await s.call('asha', 'GET', '/me')).body.user.emailReminders, false);
    assert.equal(s.sent.length, 0, 'no email is sent');
    // Other members never see someone's preferences.
    const meId = await idOf(s.call, 'asha');
    const seen = await s.call('ben', 'GET', `/users/${meId}`);
    assert.equal('emailReminders' in seen.body.user, false);
  } finally { await s.close(); }
});

// A repaid request: borrower, a lender, repaid on or before the due date (or after, per flag).
async function repaidRequest(s, borrowerId, contactId, lenderId, { repaidAt, repaymentDate = '2026-12-01' }) {
  const r = await s.repo.createRequest({ borrowerId, trustedContactId: contactId, purpose: 'School fees for the second term at college',
    category: 'education', principalCents: 50000, repaymentDate, status: 'repaid', createdAt: '2026-10-01T00:00:00.000Z' });
  await s.repo.updateRequest(r.id, { repaidAt });
  await s.repo.addContribution({ requestId: r.id, contributorId: lenderId, amountCents: 50000, status: 'confirmed', utr: '123456789012' });
  await s.repo.addRepayment({ requestId: r.id, payerId: borrowerId, lenderId, amountCents: 50000, status: 'confirmed', utr: '999999999999' });
  return r;
}

test('trust history: facts for self and mutual connections only; never overdue or unpaid', async () => {
  const s = await setup();
  try {
    const [bid, cid, lid, oid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara'), await idOf(s.call, 'lena'), await idOf(s.call, 'outsider')];
    await connect(s.call, 'bina', 'lena');
    await repaidRequest(s, bid, cid, lid, { repaidAt: '2026-11-30T10:00:00.000Z' });                       // on time
    await repaidRequest(s, bid, cid, lid, { repaidAt: '2026-12-20T10:00:00.000Z', repaymentDate: '2026-12-01' }); // late
    // An unpaid, overdue funded request must not leak into trust.
    await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'Another long enough purpose text', category: 'education',
      principalCents: 50000, repaymentDate: '2026-01-01', status: 'funded' });
    const self = (await s.call('bina', 'GET', `/users/${bid}`)).body.user;
    assert.deepEqual(Object.keys(self.trust).sort(), ['lentToCount', 'memberSince', 'repaidCount', 'repaidOnTimeCount']);
    assert.equal(self.trust.repaidCount, 2);
    assert.equal(self.trust.repaidOnTimeCount, 1);
    assert.match(self.trust.memberSince, /^\d{4}-\d{2}$/);
    assert.doesNotMatch(JSON.stringify(self.trust), /overdue|unpaid/i);
    const lender = (await s.call('lena', 'GET', `/users/${bid}`)).body.user;   // mutual
    assert.equal(lender.trust.repaidCount, 2);
    assert.equal((await s.call('bina', 'GET', `/users/${lid}`)).body.user.trust.lentToCount, 2);
    const stranger = (await s.call('outsider', 'GET', `/users/${bid}`)).body.user;
    assert.equal('trust' in stranger, false);
    assert.ok(oid);
  } finally { await s.close(); }
});

test('GET /me/statement lists the member\'s requests and loans with UTR of their own entries only', async () => {
  const s = await setup();
  try {
    const [bid, cid, lid, oid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara'), await idOf(s.call, 'lena'), await idOf(s.call, 'olga')];
    const r = await repaidRequest(s, bid, cid, lid, { repaidAt: '2026-11-30T10:00:00.000Z' });
    await s.repo.addContribution({ requestId: r.id, contributorId: oid, amountCents: 1000, status: 'sent', utr: '555555555555' });
    const st = await s.call('lena', 'GET', '/me/statement');
    assert.equal(st.status, 200);
    assert.equal(st.body.loans.length, 1);
    const loan = st.body.loans[0];
    assert.equal(loan.requestId, r.id);
    assert.equal(loan.status, 'repaid');
    assert.equal(loan.myLentCents, 50000);
    assert.equal(loan.myRepaidCents, 50000);
    assert.equal(loan.entries.find((e) => e.kind === 'contribution').utr, '123456789012');
    assert.doesNotMatch(st.text, /555555555555/);
    assert.deepEqual(st.body.requests, []);
    const b = await s.call('bina', 'GET', '/me/statement');
    assert.equal(b.body.requests.length, 1);
    const req = b.body.requests[0];
    assert.equal(req.principalCents, 50000);
    assert.equal(req.repaymentDate, '2026-12-01');
    assert.equal(req.entries.some((e) => e.kind === 'repayment' && e.utr === '999999999999'), true);
    assert.equal(b.body.loans.length, 0);
    assert.equal((await s.call(null, 'GET', '/me/statement')).status, 401);
  } finally { await s.close(); }
});

test('DELETE /me needs the typed word, and is refused while a request is active', async () => {
  const s = await setup();
  try {
    const bid = await idOf(s.call, 'bina');
    const cid = await idOf(s.call, 'cara');
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: 'yes' }]) {
      const r = await s.call('bina', 'DELETE', '/me', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'School fees for the second term at college', category: 'education',
      principalCents: 50000, repaymentDate: '2027-03-01', status: 'open' });
    const blocked = await s.call('bina', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /request/i);
    assert.equal((await s.repo.getUser(bid)).deletedAt, null);
  } finally { await s.close(); }
});

test('DELETE /me is refused while the member is owed money, or has an entry waiting to be settled', async () => {
  const s = await setup();
  try {
    const [bid, cid, lid, pid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara'), await idOf(s.call, 'lena'), await idOf(s.call, 'pia')];
    const r = await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'School fees for the second term at college', category: 'education',
      principalCents: 50000, repaymentDate: '2027-03-01', status: 'funded' });
    await s.repo.addContribution({ requestId: r.id, contributorId: lid, amountCents: 30000, status: 'confirmed' });
    const owed = await s.call('lena', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(owed.status, 409);
    assert.match(owed.body.error, /money|owed|owe/i);
    // A request that has ended, but a "sent" entry from Pia is still unconfirmed.
    const done = await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'Another long enough purpose text', category: 'education',
      principalCents: 50000, repaymentDate: '2027-03-01', status: 'closed' });
    await s.repo.addContribution({ requestId: done.id, contributorId: pid, amountCents: 1000, status: 'sent' });
    assert.equal((await s.call('pia', 'DELETE', '/me', { confirm: 'DELETE' })).status, 409);
    // Fully repaid lender can leave.
    const paid = await repaidRequest(s, bid, cid, await idOf(s.call, 'rita'), { repaidAt: '2026-11-01T00:00:00.000Z' });
    assert.ok(paid);
    assert.equal((await s.call('rita', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
  } finally { await s.close(); }
});

test('DELETE /me anonymises the member, keeps ledger rows, and removes them from search and connections', async () => {
  const s = await setup();
  try {
    const [bid, cid, lid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara'), await idOf(s.call, 'lena')];
    await connect(s.call, 'lena', 'cara');
    await s.call('lena', 'PATCH', '/me', { upiId: 'lena@okbank' });
    await s.call('lena', 'POST', '/invites', { email: 'newbie@example.com' });
    const r = await repaidRequest(s, bid, cid, lid, { repaidAt: '2026-11-30T10:00:00.000Z' });
    const lenaBefore = await s.repo.getUser(lid);
    assert.equal((await s.call('cara', 'GET', '/connections')).body.mutual.length, 1);
    assert.equal((await s.call('cara', 'GET', '/users?q=lena')).body.users.length, 1);

    const del = await s.call('lena', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await s.repo.getUser(lid);
    assert.equal(gone.name, 'Former member');
    assert.ok(gone.deletedAt);
    assert.equal(gone.upiId, null);
    assert.equal(gone.avatarUrl, null);
    assert.notEqual(gone.email, lenaBefore.email);
    assert.doesNotMatch(String(gone.email), /lena/);
    assert.equal(gone.clerkId, `deleted:${lid}`);
    // Ledger rows kept.
    assert.equal((await s.repo.listContributions(r.id)).length, 1);
    assert.equal((await s.repo.listRepayments(r.id)).length, 1);
    // Follows and open invites gone; search and connections no longer show them.
    assert.deepEqual(await s.repo.connections(lid), { following: [], followers: [] });
    assert.equal((await s.repo.listInvitesByInviter(lid)).filter((i) => !i.acceptedAt).length, 0);
    assert.equal((await s.call('cara', 'GET', '/connections')).body.mutual.length, 0);
    assert.equal((await s.call('cara', 'GET', '/users?q=lena')).body.users.length, 0);
    assert.equal((await s.call('cara', 'GET', '/users?q=Former')).body.users.length, 0);
    // The old sign-in can no longer act as that member: it is never mapped back to the deleted row.
    const again = await s.call('lena', 'GET', '/me');
    assert.notEqual(again.body.user?.id, lid);
  } finally { await s.close(); }
});

test('DELETE /me is refused while the member is the trusted contact on an active request', async () => {
  const s = await setup();
  try {
    const [bid, cid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara')];
    await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'School fees for the second term at college', category: 'education',
      principalCents: 50000, repaymentDate: '2027-03-01', status: 'open' });
    const r = await s.call('cara', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /trusted contact/i);
    assert.equal((await s.repo.getUser(cid)).deletedAt, null);
  } finally { await s.close(); }
});

test('DELETE /me removes the Clerk user after anonymising; a Clerk failure is logged without personal data and still returns 200', async () => {
  const calls = [];
  const s = await setup({ deleteClerkUser: async (id) => { calls.push(id); } });
  try {
    await s.call('ana', 'GET', '/me');
    const r = await s.call('ana', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['clerk_ana']);
  } finally { await s.close(); }
  const s2 = await setup({ deleteClerkUser: async () => { throw new Error('clerk down'); } });
  try {
    const id = await idOf(s2.call, 'bo');
    const r = await s2.call('bo', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await s2.repo.getUser(id)).deletedAt !== null, true);
    const logged = JSON.stringify(s2.logged.map((a) => a.map(String)));
    assert.match(logged, /clerk down/);
    assert.doesNotMatch(logged, /clerk_bo|bo@example\.com/);
  } finally { await s2.close(); }
});

test('a deleted member signing in again is refused when joining is invite only', async () => {
  const s = await setup({ admitAll: false, ownerEmail: 'owner@example.com' });
  try {
    const made = await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    await s.call('kim', 'GET', '/me', null, null, { 'x-invite-token': tokenOf(made.body.link) });
    assert.equal((await s.call('kim', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    const again = await s.call('kim', 'GET', '/me');
    assert.equal(again.status, 403);
    assert.equal(again.body.code, 'invite_only');
  } finally { await s.close(); }
});

test('POST /follows to a deleted member is 404', async () => {
  const s = await setup();
  try {
    const gid = await idOf(s.call, 'gone');
    await s.call('gone', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal((await s.call('asha', 'POST', '/follows', { userId: gid })).status, 404);
  } finally { await s.close(); }
});

// ---- Task 9: help requests ----
test('POST /api/help validates body (trimmed, 10 to 2000) with field body, then returns 201 and sends no mail', async () => {
  const s = await setup();
  try {
    for (const body of [undefined, 5, '', '   short   ', 'x'.repeat(2001), `  ${'y'.repeat(9)}  `]) {
      const r = await s.call('asha', 'POST', '/help', { body });
      assert.equal(r.status, 400, String(body));
      assert.equal(r.body.field, 'body');
    }
    const ok = await s.call('asha', 'POST', '/help', { body: `  ${'z'.repeat(10)}  ` });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body, { ok: true });
    assert.equal((await s.call('asha', 'POST', '/help', { body: 'x'.repeat(2000) })).status, 201);
    const mine = await s.call('asha', 'GET', '/help/mine');
    assert.ok(mine.body.messages.some((m) => m.body === 'z'.repeat(10)), 'stored trimmed');
    assert.equal(s.sent.length, 0, 'no email is sent');
    assert.equal((await s.call(null, 'POST', '/help', { body: 'a'.repeat(12) })).status, 401);
  } finally { await s.close(); }
});

test('GET /api/help/mine shows only the viewer\'s own messages, with no email or user ids', async () => {
  const s = await setup();
  try {
    await s.call('asha', 'POST', '/help', { body: 'Asha needs help with a thing' });
    await s.call('ben', 'POST', '/help', { body: 'Ben has a different problem' });
    const a = await s.call('asha', 'GET', '/help/mine');
    assert.equal(a.status, 200);
    assert.equal(a.body.messages.length, 1);
    assert.deepEqual(Object.keys(a.body.messages[0]).sort(), ['body', 'createdAt', 'resolvedAt']);
    assert.equal(a.body.messages[0].body, 'Asha needs help with a thing');
    assert.equal(a.body.messages[0].resolvedAt, null);
    assert.doesNotMatch(a.text, /Ben has/);
    assert.equal((await s.call(null, 'GET', '/help/mine')).status, 401);
  } finally { await s.close(); }
});

test('admin help list: 401 anonymous, 403 member, 200 owner with names and emails, unresolved first', async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me', null, null, { 'x-test-email': 'boss@example.com' });
    await s.call('asha', 'POST', '/help', { body: 'First message from Asha' });
    await s.call('ben', 'POST', '/help', { body: 'Second message from Ben' });
    assert.equal((await s.call(null, 'GET', '/admin/help-messages')).status, 401);
    const denied = await s.call('asha', 'GET', '/admin/help-messages');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: 'Admins only' });
    const asBoss = { 'x-test-email': 'boss@example.com' };
    const list = await s.call('boss', 'GET', '/admin/help-messages', null, null, asBoss);
    assert.equal(list.status, 200);
    assert.equal(list.body.messages.length, 2);
    const first = list.body.messages.find((m) => m.body.startsWith('First'));
    assert.equal(first.name, 'asha');
    assert.equal(first.email, 'asha@example.com');
    assert.equal(first.resolvedAt, null);
    // Resolve the first: it moves behind the unresolved one.
    const done = await s.call('boss', 'POST', `/admin/help-messages/${first.id}/resolve`, null, null, asBoss);
    assert.equal(done.status, 200);
    const after = (await s.call('boss', 'GET', '/admin/help-messages', null, null, asBoss)).body.messages;
    assert.equal(after[0].body.startsWith('Second'), true);
    assert.ok(after[1].resolvedAt);
    // The sender sees it as resolved.
    const mine = (await s.call('asha', 'GET', '/help/mine')).body.messages[0];
    assert.ok(mine.resolvedAt);
  } finally { await s.close(); }
});

test('resolve: sets resolvedAt once (idempotent), 404 when missing, 403 for a member, 401 anonymous', async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    const asBoss = { 'x-test-email': 'boss@example.com' };
    await s.call('boss', 'GET', '/me', null, null, asBoss);
    await s.call('asha', 'POST', '/help', { body: 'Please look at my account' });
    const id = (await s.call('boss', 'GET', '/admin/help-messages', null, null, asBoss)).body.messages[0].id;
    assert.equal((await s.call('asha', 'POST', `/admin/help-messages/${id}/resolve`)).status, 403);
    assert.equal((await s.call(null, 'POST', `/admin/help-messages/${id}/resolve`)).status, 401);
    const one = await s.call('boss', 'POST', `/admin/help-messages/${id}/resolve`, null, null, asBoss);
    assert.equal(one.status, 200);
    assert.ok(one.body.message.resolvedAt);
    s.setNow(new Date('2026-12-01T12:00:00Z'));
    const two = await s.call('boss', 'POST', `/admin/help-messages/${id}/resolve`, null, null, asBoss);
    assert.equal(two.status, 200);
    assert.equal(two.body.message.resolvedAt, one.body.message.resolvedAt, 'first timestamp kept');
    assert.equal((await s.call('boss', 'POST', '/admin/help-messages/999999/resolve', null, null, asBoss)).status, 404);
    assert.equal((await s.call('boss', 'POST', '/admin/help-messages/abc/resolve', null, null, asBoss)).status, 404);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

// ---- Task 10: owner admin routes ----
const BOSS = { 'x-test-email': 'boss@example.com' };
async function adminSetup() {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  await s.call('boss', 'GET', '/me', null, null, BOSS);
  const admin = (method, p, body) => s.call('boss', method, `/admin${p}`, body, null, BOSS);
  return { s, admin };
}
const ADMIN_ROUTES = [
  ['GET', '/admin/members'], ['POST', '/admin/members/1/verifier', { on: true }], ['POST', '/admin/members/1/invite-limit', { limit: 3 }],
  ['GET', '/admin/invites'], ['DELETE', '/admin/invites/1'], ['GET', '/admin/stats'], ['GET', '/admin/verification-gaps'],
  ['GET', '/admin/stuck'], ['POST', '/admin/contributions/1/settle', { action: 'remove', note: 'a valid note' }],
  ['POST', '/admin/repayments/1/settle', { action: 'remove', note: 'a valid note' }],
];

test('every admin route is 401 for anonymous and 403 for a member', async () => {
  const { s } = await adminSetup();
  try {
    await s.call('asha', 'GET', '/me');
    for (const [method, p, body] of ADMIN_ROUTES) {
      assert.equal((await s.call(null, method, p, body)).status, 401, `${method} ${p} anonymous`);
      const r = await s.call('asha', method, p, body);
      assert.equal(r.status, 403, `${method} ${p} member`);
      assert.deepEqual(r.body, { error: 'Admins only' });
    }
  } finally { await s.close(); }
});

test('members list: owner view with email, verifier flag, invite limit and invites this IST month', async () => {
  const { s, admin } = await adminSetup();
  try {
    const asha = await idOf(s.call, 'asha');
    await s.call('asha', 'POST', '/invites', { email: 'a1@example.com' });
    const second = await s.call('asha', 'POST', '/invites', { email: 'a2@example.com' });
    await s.call('asha', 'POST', '/invites', { email: 'a3@example.com' });
    await s.call('asha', 'DELETE', `/invites/${second.body.invite.id}`);
    const list = await admin('GET', '/members');
    assert.equal(list.status, 200);
    const row = list.body.members.find((m) => m.id === asha);
    assert.deepEqual(row, { id: asha, name: 'asha', email: 'asha@example.com', isVerifier: false, inviteLimit: null, invitesThisMonth: 2 });
    const boss = list.body.members.find((m) => m.name === 'boss');
    assert.equal(boss.isVerifier, true);
    // Last month's invite does not count.
    s.setNow(new Date('2026-12-02T12:00:00Z'));
    assert.equal((await admin('GET', '/members')).body.members.find((m) => m.id === asha).invitesThisMonth, 0);
  } finally { await s.close(); }
});

test('verifier toggle: boolean only, 404 unknown, owner cannot remove their own status', async () => {
  const { s, admin } = await adminSetup();
  try {
    const asha = await idOf(s.call, 'asha');
    const boss = (await s.call('boss', 'GET', '/me', null, null, BOSS)).body.user.id;
    for (const on of [undefined, 'true', 1, null]) {
      const r = await admin('POST', `/members/${asha}/verifier`, { on });
      assert.equal(r.status, 400, String(on));
    }
    assert.equal((await admin('POST', '/members/999999/verifier', { on: true })).status, 404);
    assert.equal((await admin('POST', '/members/abc/verifier', { on: true })).status, 404);
    const on = await admin('POST', `/members/${asha}/verifier`, { on: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.member.isVerifier, true);
    assert.equal((await s.call('asha', 'GET', '/me')).body.user.isVerifier, true);
    assert.equal((await admin('POST', `/members/${asha}/verifier`, { on: false })).body.member.isVerifier, false);
    assert.equal((await admin('POST', `/members/${boss}/verifier`, { on: false })).status, 409);
    assert.equal((await admin('POST', `/members/${boss}/verifier`, { on: true })).status, 200);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('invite limit: integer 0 to 50 or null to reset, and it is enforced on the member', async () => {
  const { s, admin } = await adminSetup();
  try {
    const asha = await idOf(s.call, 'asha');
    for (const limit of [-1, 51, 2.5, '3', undefined, true]) {
      const r = await admin('POST', `/members/${asha}/invite-limit`, { limit });
      assert.equal(r.status, 400, String(limit));
      assert.equal(r.body.field, 'limit');
    }
    assert.equal((await admin('POST', '/members/999999/invite-limit', { limit: 3 })).status, 404);
    const zero = await admin('POST', `/members/${asha}/invite-limit`, { limit: 0 });
    assert.equal(zero.body.member.inviteLimit, 0);
    assert.equal((await s.call('asha', 'POST', '/invites', { email: 'z@example.com' })).status, 429);
    assert.equal((await admin('POST', `/members/${asha}/invite-limit`, { limit: 50 })).body.member.inviteLimit, 50);
    assert.equal((await s.call('asha', 'POST', '/invites', { email: 'z@example.com' })).status, 201);
    const reset = await admin('POST', `/members/${asha}/invite-limit`, { limit: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.member.inviteLimit, null);
  } finally { await s.close(); }
});

test('admin invites: all invites with state, inviter name and invitee email; revoke is idempotent; 404 when missing', async () => {
  const { s, admin } = await adminSetup();
  try {
    const open = await s.call('asha', 'POST', '/invites', { email: 'open@example.com' });
    const used = await s.call('ben', 'POST', '/invites', { email: 'used@example.com' });
    await s.call('used', 'GET', '/me', null, null, { 'x-invite-token': tokenOf(used.body.link) });
    const list = await admin('GET', '/invites');
    assert.equal(list.status, 200);
    const byEmail = Object.fromEntries(list.body.invites.map((i) => [i.email, i]));
    assert.equal(byEmail['open@example.com'].state, 'open');
    assert.equal(byEmail['open@example.com'].inviterName, 'asha');
    assert.equal(byEmail['used@example.com'].state, 'accepted');
    assert.equal(byEmail['used@example.com'].inviterName, 'ben');
    assert.doesNotMatch(list.text, /tokenHash|token_hash|#join=/);
    const first = await admin('DELETE', `/invites/${open.body.invite.id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.invite.state, 'revoked');
    const again = await admin('DELETE', `/invites/${open.body.invite.id}`);
    assert.equal(again.status, 200);
    assert.equal(again.body.invite.state, 'revoked');
    assert.equal((await admin('DELETE', '/invites/999999')).status, 404);
    assert.equal((await admin('DELETE', '/invites/xyz')).status, 404);
    s.setNow(new Date('2027-03-01T00:00:00Z'));
    const later = await s.call('asha', 'POST', '/invites', { email: 'late@example.com' });
    s.setNow(new Date('2027-05-01T00:00:00Z'));
    const expired = (await admin('GET', '/invites')).body.invites.find((i) => i.id === later.body.invite.id);
    assert.equal(expired.state, 'expired');
  } finally { await s.close(); }
});

test('stats: invites sent, accepted, and accepted members who made or funded a request', async () => {
  const { s, admin } = await adminSetup();
  try {
    assert.deepEqual((await admin('GET', '/stats')).body, { invitesSent: 0, invitesAccepted: 0, acceptedWhoMadeOrFunded: 0 });
    const join = async (inviter, email) => {
      const made = await s.call(inviter, 'POST', '/invites', { email });
      await s.call(email.split('@')[0], 'GET', '/me', null, null, { 'x-invite-token': tokenOf(made.body.link) });
    };
    await join('boss', 'cam@example.com');
    await join('boss', 'dee@example.com');
    await join('boss', 'eli@example.com');
    await s.call('boss', 'POST', '/invites', { email: 'pending@example.com' });
    // cam makes a request; eli funds one; dee does nothing.
    const id = await startRequest(s.call, 'cam', 'dee');
    await s.repo.setVerifier(await idOf(s.call, 'boss'), true);
    await s.call('boss', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.repo.setVerifier(await idOf(s.call, 'dee'), false);
    const stats = await admin('GET', '/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.invitesSent, 4);
    assert.equal(stats.body.invitesAccepted, 3);
    assert.equal(stats.body.acceptedWhoMadeOrFunded, 1);
    const eli = await idOf(s.call, 'eli');
    await s.repo.addContribution({ requestId: id, contributorId: eli, amountCents: 100, status: 'sent' });
    assert.equal((await admin('GET', '/stats')).body.acceptedWhoMadeOrFunded, 1, 'a sent entry is not funding yet');
    await s.repo.addContribution({ requestId: id, contributorId: eli, amountCents: 100, status: 'confirmed' });
    assert.equal((await admin('GET', '/stats')).body.acceptedWhoMadeOrFunded, 2);
  } finally { await s.close(); }
});

test('verification gaps: pending requests with fewer than two eligible verifiers (not the borrower or trusted contact)', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await startRequest(s.call, 'bea', 'cal');
    const [boss, bea, cal, dan, eve] = [await idOf(s.call, 'boss'), await idOf(s.call, 'bea'), await idOf(s.call, 'cal'), await idOf(s.call, 'dan'), await idOf(s.call, 'eve')];
    // Only the owner is a verifier: one eligible.
    let gaps = (await admin('GET', '/verification-gaps')).body.requests;
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].requestId, id);
    assert.equal(gaps[0].borrowerName, 'bea');
    assert.equal(gaps[0].eligibleVerifiers, 1);
    // The borrower and the trusted contact being verifiers does not help.
    await s.repo.setVerifier(bea, true); await s.repo.setVerifier(cal, true);
    assert.equal((await admin('GET', '/verification-gaps')).body.requests[0].eligibleVerifiers, 1);
    await s.repo.setVerifier(dan, true);
    assert.deepEqual((await admin('GET', '/verification-gaps')).body.requests, []);
    await s.repo.setVerifier(dan, false);
    await s.repo.setVerifier(eve, true);
    assert.deepEqual((await admin('GET', '/verification-gaps')).body.requests, []);
    // Once the request is decided it leaves the list.
    await s.repo.setVerifier(eve, false);
    await s.repo.setVerifier(dan, true);
    await s.repo.setVerifier(boss, true);
    await s.call('boss', 'POST', `/requests/${id}/verify`, { decision: 'reject', reason: 'not enough detail' });
    assert.deepEqual((await admin('GET', '/verification-gaps')).body.requests, []);
  } finally { await s.close(); }
});

// Opens a request so lenders can send money. Returns ids.
async function openFunded(s, { borrower = 'bo', contact = 'cy', lender = 'li' } = {}) {
  const id = await startRequest(s.call, borrower, contact);
  for (const v of ['v1', 'v2']) {
    await s.call(v, 'GET', '/me');
    await s.repo.setVerifier(await idOf(s.call, v), true);
    await s.call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  }
  await connect(s.call, borrower, lender);
  return id;
}

test('stuck: sent or not_received entries untouched for 7 IST days, with amounts, request id and names', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    const c1 = await lend(s.call, 'li', 'bo', id, 100, { confirm: false });
    const sent2 = await s.call('li', 'POST', `/requests/${id}/contributions`, { amount: 50 });
    await s.call('bo', 'POST', `/contributions/${sent2.body.contribution.id}/not-received`);
    assert.deepEqual((await admin('GET', '/stuck')).body.entries, []);
    s.setNow(new Date('2026-11-26T12:00:00Z'));
    assert.deepEqual((await admin('GET', '/stuck')).body.entries, [], 'six days');
    s.setNow(new Date('2026-11-27T12:00:00Z'));
    const entries = (await admin('GET', '/stuck')).body.entries;
    assert.equal(entries.length, 2);
    const e1 = entries.find((e) => e.id === c1);
    assert.equal(e1.kind, 'contribution');
    assert.equal(e1.requestId, id);
    assert.equal(e1.amountCents, 10000);
    assert.equal(e1.status, 'sent');
    assert.equal(e1.payerName, 'li');
    assert.equal(e1.receiverName, 'bo');
    assert.ok(e1.daysWaiting >= 7);
    assert.doesNotMatch(JSON.stringify(entries), /@example\.com|upi/i);
    // Touching an entry resets the clock.
    await s.call('bo', 'POST', `/contributions/${c1}/not-received`);
    assert.equal((await admin('GET', '/stuck')).body.entries.some((e) => e.id === c1), false);
  } finally { await s.close(); }
});

test('settle contribution: note 5 to 500, 409 when recent, confirm funds the request, remove deletes, no email', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    const cid = await lend(s.call, 'li', 'bo', id, 500, { confirm: false });
    const path = `/contributions/${cid}/settle`;
    for (const note of [undefined, '', '  ab  ', 'x'.repeat(501), 7]) {
      const r = await admin('POST', path, { action: 'confirm', note });
      assert.equal(r.status, 400, String(note));
      assert.equal(r.body.field, 'note');
    }
    assert.equal((await admin('POST', path, { action: 'refund', note: 'a valid note' })).status, 400);
    const recent = await admin('POST', path, { action: 'confirm', note: 'Borrower confirmed by phone' });
    assert.equal(recent.status, 409, 'untouched less than 7 days');
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    assert.equal((await admin('POST', '/contributions/999999/settle', { action: 'confirm', note: 'a valid note' })).status, 404);
    s.sent.length = 0;
    const ok = await admin('POST', path, { action: 'confirm', note: '  Borrower confirmed by phone  ' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const c = await s.repo.getContribution(cid);
    assert.equal(c.status, 'confirmed');
    assert.ok(c.confirmedAt);
    assert.equal(c.settledBy, await idOf(s.call, 'boss'));
    assert.equal(c.settledNote, 'Borrower confirmed by phone');
    assert.ok(c.settledAt);
    assert.equal((await s.repo.getRequest(id)).status, 'funded', 'request recomputed as funded');
    assert.equal(s.sent.length, 0, 'no email');
    assert.equal((await admin('POST', path, { action: 'confirm', note: 'again please ok' })).status, 409, 'already confirmed');
  } finally { await s.close(); }
});

test('settle contribution remove: deletes a stuck entry only; a confirmed one is never removed', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    const stuck = await lend(s.call, 'li', 'bo', id, 100, { confirm: false });
    const done = await lend(s.call, 'li', 'bo', id, 100, { confirm: true });
    s.setNow(new Date('2026-12-05T12:00:00Z'));
    assert.equal((await admin('POST', `/contributions/${done}/settle`, { action: 'remove', note: 'cleaning up' })).status, 409);
    assert.ok(await s.repo.getContribution(done));
    const r = await admin('POST', `/contributions/${stuck}/settle`, { action: 'remove', note: 'Lender says it never went' });
    assert.equal(r.status, 200);
    const kept = await s.repo.getContribution(stuck);
    assert.equal(kept.status, 'removed', 'row kept as an audit record');
    assert.equal(kept.settledBy, await idOf(s.call, 'boss'));
    assert.equal(kept.settledNote, 'Lender says it never went');
    assert.ok(kept.settledAt);
    assert.equal((await s.repo.getRequest(id)).status, 'open');
    assert.equal(s.sent.filter((m) => /settle|removed/i.test(m.subject)).length, 0);
  } finally { await s.close(); }
});

test('the owner cannot settle an entry they paid or received', async () => {
  const { s, admin } = await adminSetup();
  try {
    const bossId = await idOf(s.call, 'boss');
    // Owner is the lender.
    const id = await openFunded(s, { borrower: 'bo', contact: 'cy', lender: 'boss' });
    const mine = await lend(s.call, 'boss', 'bo', id, 100, { confirm: false });
    // Owner is the borrower.
    const id2 = await openFunded(s, { borrower: 'boss', contact: 'cz', lender: 'li2' });
    const toMe = await lend(s.call, 'li2', 'boss', id2, 100, { confirm: false });
    s.setNow(new Date('2026-12-10T12:00:00Z'));
    for (const cid of [mine, toMe]) {
      const r = await admin('POST', `/contributions/${cid}/settle`, { action: 'confirm', note: 'valid note here' });
      assert.equal(r.status, 409, String(cid));
      assert.ok((await s.repo.getContribution(cid)).status !== 'confirmed');
    }
    assert.ok(bossId);
  } finally { await s.close(); }
});

test('settle repayment: same rules; confirm recomputes the request as repaid; remove deletes', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    await lend(s.call, 'li', 'bo', id, 500, { confirm: true });
    assert.equal((await s.repo.getRequest(id)).status, 'funded');
    const lenderId = await idOf(s.call, 'li');
    const paid = await s.call('bo', 'POST', `/requests/${id}/repayments`, { lenderId, amount: 500 });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const pid = paid.body.repayment.id;
    const path = `/repayments/${pid}/settle`;
    assert.equal((await admin('POST', path, { action: 'confirm', note: 'a valid note' })).status, 409, 'recent');
    assert.equal((await admin('POST', path, { action: 'confirm', note: 'abc' })).status, 400);
    s.setNow(new Date('2026-12-01T12:00:00Z'));
    s.sent.length = 0;
    const ok = await admin('POST', path, { action: 'confirm', note: 'Lender confirmed by phone' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const p = await s.repo.getRepayment(pid);
    assert.equal(p.status, 'confirmed');
    assert.equal(p.settledNote, 'Lender confirmed by phone');
    assert.ok(p.settledBy && p.settledAt && p.confirmedAt);
    assert.equal((await s.repo.getRequest(id)).status, 'repaid');
    assert.equal(s.sent.length, 0, 'no email');
    assert.equal((await admin('POST', '/repayments/999999/settle', { action: 'remove', note: 'a valid note' })).status, 404);
  } finally { await s.close(); }
});

test('settle repayment remove deletes a stuck not_received repayment', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    await lend(s.call, 'li', 'bo', id, 500, { confirm: true });
    const lenderId = await idOf(s.call, 'li');
    const paid = await s.call('bo', 'POST', `/requests/${id}/repayments`, { lenderId, amount: 100 });
    const pid = paid.body.repayment.id;
    await s.call('li', 'POST', `/repayments/${pid}/not-received`);
    s.setNow(new Date('2026-12-01T12:00:00Z'));
    const listed = (await admin('GET', '/stuck')).body.entries.find((e) => e.kind === 'repayment');
    assert.equal(listed.id, pid);
    assert.equal(listed.payerName, 'bo');
    assert.equal(listed.receiverName, 'li');
    assert.equal((await admin('POST', `/repayments/${pid}/settle`, { action: 'remove', note: 'Payer says it never went' })).status, 200);
    const kept = await s.repo.getRepayment(pid);
    assert.equal(kept.status, 'removed');
    assert.equal(kept.settledNote, 'Payer says it never went');
    assert.ok(kept.settledBy && kept.settledAt);
    assert.equal((await s.repo.listRepayments(id)).some((x) => x.id === pid), false, 'not in the request ledger');
  } finally { await s.close(); }
});

test('settle routes: a throwing repo gives a 500 JSON error, a missing request gives 404', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    const cid = await lend(s.call, 'li', 'bo', id, 100, { confirm: false });
    s.setNow(new Date('2026-12-05T12:00:00Z'));
    const orphan = await s.repo.addContribution({ requestId: 999999, contributorId: await idOf(s.call, 'li'), amountCents: 100, status: 'sent', createdAt: '2026-11-01T00:00:00.000Z' });
    const missing = await admin('POST', `/contributions/${orphan.id}/settle`, { action: 'remove', note: 'a valid note' });
    assert.equal(missing.status, 404);
    const real = s.repo.updateContribution;
    s.repo.updateContribution = async () => { throw new Error('db down'); };
    try {
      const r = await Promise.race([
        admin('POST', `/contributions/${cid}/settle`, { action: 'confirm', note: 'a valid note' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000)),
      ]);
      assert.equal(r.status, 500);
      assert.ok(r.body.error);
      assert.doesNotMatch(r.text, /db down/);
    } finally { s.repo.updateContribution = real; }
  } finally { await s.close(); }
});

test('a removed entry is excluded from totals and funding; the owner can still fund; members cannot touch it', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openFunded(s);
    const stuck = await lend(s.call, 'li', 'bo', id, 400, { confirm: false });
    // 400 pending leaves 100: a 500 contribution is refused until the entry is removed.
    assert.equal((await s.call('li', 'POST', `/requests/${id}/contributions`, { amount: 500 })).status, 409);
    s.setNow(new Date('2026-12-05T12:00:00Z'));
    assert.equal((await admin('POST', `/contributions/${stuck}/settle`, { action: 'remove', note: 'Lender says it never went' })).status, 200);
    const detail = await s.call('bo', 'GET', `/requests/${id}`);
    assert.equal(JSON.stringify(detail.body).includes(`"id":${stuck},`), false, 'removed entry is not shown');
    const full = await lend(s.call, 'li', 'bo', id, 500, { confirm: true });
    assert.ok(full);
    assert.equal((await s.repo.getRequest(id)).status, 'funded', 'funded from real money only');
    assert.equal((await admin('GET', '/stuck')).body.entries.some((e) => e.id === stuck), false);
    assert.equal((await admin('POST', `/contributions/${stuck}/settle`, { action: 'confirm', note: 'a valid note' })).status, 409, 'cannot be settled twice');
    for (const [who, method, p, body] of [['li', 'DELETE', `/contributions/${stuck}`], ['bo', 'POST', `/contributions/${stuck}/confirm`], ['li', 'PATCH', `/contributions/${stuck}`, { amount: 5 }]]) {
      assert.equal((await s.call(who, method, p, body)).status, 404, `${method} ${p}`);
    }
    assert.equal((await s.repo.getContribution(stuck)).status, 'removed', 'row survives');
  } finally { await s.close(); }
});

test('admin invites show the email the person joined with and flag a difference', async () => {
  const { s, admin } = await adminSetup();
  try {
    const made = await s.call('asha', 'POST', '/invites', { email: 'a@x.example' });
    await s.call('bee', 'GET', '/me', null, null, { 'x-invite-token': tokenOf(made.body.link), 'x-test-email': 'b@y.example' });
    const same = await s.call('asha', 'POST', '/invites', { email: 'cat@example.com' });
    await s.call('cat', 'GET', '/me', null, null, { 'x-invite-token': tokenOf(same.body.link) });
    await s.call('asha', 'POST', '/invites', { email: 'open@example.com' });
    const list = (await admin('GET', '/invites')).body.invites;
    const diff = list.find((i) => i.email === 'a@x.example');
    assert.equal(diff.state, 'accepted');
    assert.equal(diff.joinedEmail, 'b@y.example');
    assert.equal(list.find((i) => i.email === 'cat@example.com').joinedEmail, 'cat@example.com');
    assert.equal(list.find((i) => i.email === 'open@example.com').joinedEmail, null);
  } finally { await s.close(); }
});
