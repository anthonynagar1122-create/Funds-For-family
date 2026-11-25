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

// ---- Task 8: email preferences, trust, statement, account deletion ----
const { idOf, connect } = require('./helpers/lifecycle');

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

test('admin member management is role-gated and role changes are audited', async () => {
  const s = await setup({ ownerEmail: 'owner@example.com' });
  try {
    const owner = await s.call('owner', 'GET', '/me');
    const member = await s.call('member', 'GET', '/me');
    assert.equal(owner.body.user.isAdmin, true);
    assert.equal(member.body.user.isAdmin, false);
    assert.equal((await s.call('member', 'GET', '/admin/members')).status, 403);
    assert.equal((await s.call('member', 'GET', '/admin/audit-events')).status, 403);
    assert.equal((await s.call('member', 'GET', '/admin/operations')).status, 403);
    const listed = await s.call('owner', 'GET', '/admin/members');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.members.some((u) => u.id === member.body.user.id));
    const invalid = await s.call('owner', 'PATCH', '/admin/members/' + member.body.user.id + '/roles', { isAdmin: true });
    assert.equal(invalid.status, 400);
    const changed = await s.call('owner', 'PATCH', '/admin/members/' + member.body.user.id + '/roles', { isAdmin: false, isVerifier: true });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.member.isVerifier, true);
    assert.equal((await s.call('member', 'GET', '/me')).body.user.isVerifier, true);
    const audit = await s.call('owner', 'GET', '/admin/audit-events');
    assert.equal(audit.status, 200);
    assert.equal(audit.body.events.length, 1);
    assert.equal(audit.body.events[0].actorName, 'owner');
    assert.equal(audit.body.events[0].targetName, 'member');
    assert.deepEqual(audit.body.events[0].beforeState, { isAdmin: false, isVerifier: false });
    assert.deepEqual(audit.body.events[0].afterState, { isAdmin: false, isVerifier: true });
    const ops = await s.call('owner', 'GET', '/admin/operations');
    assert.equal(ops.status, 200);
    assert.equal(ops.body.metrics.members, 2);
    assert.equal(ops.body.metrics.admins, 1);
    assert.equal(ops.body.metrics.verifiers, 2);
  } finally { await s.close(); }
});

test('admin role management cannot remove the final administrator', async () => {
  const s = await setup({ ownerEmail: 'owner@example.com' });
  try {
    const owner = (await s.call('owner', 'GET', '/me')).body.user;
    const response = await s.call('owner', 'PATCH', '/admin/members/' + owner.id + '/roles', { isAdmin: false, isVerifier: false });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /last administrator/i);
    const stillAdmin = await s.call('owner', 'GET', '/me');
    assert.equal(stillAdmin.body.user.isAdmin, true);
    const audit = await s.call('owner', 'GET', '/admin/audit-events');
    assert.equal(audit.body.events.length, 0);
  } finally { await s.close(); }
});


test('admin can assign, reassign and unassign support messages with an audit trail', async () => {
  const s = await setup({ ownerEmail:'owner@example.com' });
  try {
    const owner=(await s.call('owner','GET','/me')).body.user;
    const member=(await s.call('member','GET','/me')).body.user;
    const created=await s.call('member','POST','/help',{body:'Please help me update my account details'});
    assert.equal(created.status,201);
    const inbox=await s.call('owner','GET','/admin/help-messages');
    const id=inbox.body.messages[0].id;
    assert.equal(inbox.body.messages[0].assignedToId,null);
    assert.equal((await s.call('member','POST','/admin/help-messages/'+id+'/assign',{assigneeId:owner.id})).status,403);
    const invalid=await s.call('owner','POST','/admin/help-messages/'+id+'/assign',{assigneeId:member.id});
    assert.equal(invalid.status,400);
    const assigned=await s.call('owner','POST','/admin/help-messages/'+id+'/assign',{assigneeId:member.id+1000});
    assert.equal(assigned.status,400);
    const verifier=await s.repo.createUser({clerkId:'verifier-clerk',name:'verifier',email:'verifier@example.com',isVerifier:true});
    const response=await s.call('owner','POST','/admin/help-messages/'+id+'/assign',{assigneeId:verifier.id});
    assert.equal(response.status,200);
    assert.equal(response.body.message.assignedToId,verifier.id);
    assert.equal(response.body.message.assignedToName,'verifier');
    const reassign=await s.call('owner','POST','/admin/help-messages/'+id+'/assign',{assigneeId:owner.id});
    assert.equal(reassign.status,200);
    assert.equal(reassign.body.message.assignedToId,owner.id);
    const unassign=await s.call('owner','POST','/admin/help-messages/'+id+'/assign',{assigneeId:null});
    assert.equal(unassign.status,200);
    assert.equal(unassign.body.message.assignedToId,null);
    const audit=await s.repo.listSupportAuditEvents();
    assert.deepEqual(audit.map(e=>e.eventType),['support.unassigned','support.assigned','support.assigned']);
    const adminAudit=await s.call('owner','GET','/admin/audit-events');
    assert.equal(adminAudit.status,200);
    assert.equal(adminAudit.body.events.filter(e=>e.eventType.startsWith('support.')).length,3);
    assert.equal(audit[0].actorId,owner.id);
    assert.equal(audit[0].helpMessageId,id);
  } finally { await s.close(); }
});

test('support resolution is admin-only and writes a single audit event', async () => {
  const s=await setup({ownerEmail:'owner@example.com'});
  try {
    const created=await s.call('member','POST','/help',{body:'I need help with my repayment history'});
    assert.equal(created.status,201);
    const id=(await s.call('owner','GET','/admin/help-messages')).body.messages[0].id;
    assert.equal((await s.call('member','POST','/admin/help-messages/'+id+'/resolve')).status,403);
    const first=await s.call('owner','POST','/admin/help-messages/'+id+'/resolve');
    assert.equal(first.status,200);
    assert.ok(first.body.message.resolvedAt);
    const second=await s.call('owner','POST','/admin/help-messages/'+id+'/resolve');
    assert.equal(second.status,200);
    assert.equal(second.body.message.resolvedAt,first.body.message.resolvedAt);
    const audit=await s.repo.listSupportAuditEvents();
    assert.equal(audit.length,1);
    assert.equal(audit[0].eventType,'support.resolved');
  } finally { await s.close(); }
});
