'use strict';
// Journey audit: LENDER and VERIFIER, walked end to end through the API (memory repo, fixed clock).
// Tests without `todo` pass today and pin what WORKS. Tests marked `todo: 'gap: ...'` carry the real assertions the
// fixed behaviour must meet; they fail today (or pass trivially only once the gap is closed). Field names marked
// "proposed" are the audit's suggestion where the spec names the behaviour but not the JSON shape.
// Report: docs/production-readiness/02-lender-and-verifier.md
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('../helpers/harness');
const { idOf, connect, startRequest, lend } = require('../helpers/lifecycle');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

async function makeVerifiers(s, ...names) {
  for (const n of names) await s.repo.setVerifier(await idOf(s.call, n), true);
}

/** Borrower + trusted contact + two verifiers; returns the request id, now open. */
async function openRequest(s, { borrower = 'ravi', contact = 'kiran', verifiers = ['vee', 'wes'], extra } = {}) {
  await makeVerifiers(s, ...verifiers);
  const id = await startRequest(s.call, borrower, contact, extra);
  for (const v of verifiers) {
    const r = await s.call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return id;
}

/** Open request fully funded by one lender (ravi borrows 500 from lata). Returns { id, cid }. */
async function fundedRequest(s) {
  const id = await openRequest(s);
  await connect(s.call, 'ravi', 'lata');
  const cid = await lend(s.call, 'lata', 'ravi', id, 500);
  return { id, cid };
}

const needs = async (s, user) => (await s.call(user, 'GET', '/home')).body.needsYou;
const lastMail = (s, to) => [...s.sent].reverse().find((m) => m.to === to);

// ---------------------------------------------------------------------------------------------------------------
// LENDER: end to end
// ---------------------------------------------------------------------------------------------------------------

test('lender journey: invited, welcomed, finds the request, pays, borrower confirms, repaid in instalments, statement and trust', async () => {
  const s = await setup({ admitAll: false, ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me'); // the owner is admin and a verifier
    const join = async (name) => {
      const inv = await s.call('boss', 'POST', '/invites', { email: `${name}@example.com` });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      const me = await s.call(name, 'GET', '/me', null, null, { 'x-invite-token': inv.body.link.split('#join=')[1] });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      return me.body.user;
    };
    const lata = await join('lata');
    for (const n of ['ravi', 'kiran', 'vee']) await join(n);
    await s.repo.setVerifier(await idOf(s.call, 'vee'), true);

    // Invited -> welcome: connected to the inviter at once, three welcome calls, then Home.
    assert.equal(lata.welcomedAt, null);
    assert.equal(lata.inviterName, 'boss');
    const conn = await s.call('lata', 'GET', '/connections');
    assert.ok(conn.body.mutual.some((u) => u.name === 'boss'), 'lender is mutual with the inviter');
    assert.equal((await s.call('lata', 'PATCH', '/me', { name: 'Lata Rao', upiId: 'lata@okbank' })).status, 200);
    assert.ok((await s.call('lata', 'POST', '/me/accept-terms')).body.user.termsAcceptedAt);
    assert.ok((await s.call('lata', 'POST', '/me/welcomed')).body.user.welcomedAt);
    assert.deepEqual((await s.call('lata', 'GET', '/home')).body.needsYou, []);

    // Borrower's request (500 rupees) goes through consent and verification. Nothing shows in the lender's feed before it opens.
    assert.equal((await s.call('ravi', 'PATCH', '/me', { upiId: 'ravi@okbank' })).status, 200);
    await connect(s.call, 'ravi', 'lata');
    const id = await startRequest(s.call, 'ravi', 'kiran');
    assert.equal((await s.call('lata', 'GET', '/feed')).body.requests.length, 0);
    assert.equal((await s.call('lata', 'GET', `/requests/${id}`)).status, 404);
    for (const v of ['boss', 'vee']) assert.equal((await s.call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' })).status, 200);

    // Discover: the mutual connection's open request is in the feed and readable, with the borrower's UPI ID to pay.
    const feed = (await s.call('lata', 'GET', '/feed')).body.requests;
    assert.deepEqual(feed.map((r) => [r.id, r.status]), [[id, 'open']]);
    const detail = (await s.call('lata', 'GET', `/requests/${id}`)).body.request;
    assert.equal(detail.remainingCents, 50000);
    assert.deepEqual(detail.payTo.map((t) => t.upiId), ['ravi@okbank']);

    // Pay (outside the app), record "sent" with a UTR. The borrower is told and sees it under Needs you.
    const sent = await s.call('lata', 'POST', `/requests/${id}/contributions`, { amount: '200', utr: 'UTR123456' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.contribution.status, 'sent');
    assert.equal(sent.body.request.totals.confirmedCents, 0, 'sent money is not counted until confirmed');
    assert.match(lastMail(s, 'ravi@example.com').subject, /Please confirm/);
    const first = sent.body.contribution.id;
    assert.deepEqual((await needs(s, 'ravi')).filter((n) => n.kind === 'confirm_contribution').map((n) => n.entryId), [first]);

    // Borrower says not received: the lender is emailed, sees a Fix item, corrects the amount, and it goes back to sent.
    assert.equal((await s.call('ravi', 'POST', `/contributions/${first}/not-received`)).status, 200);
    assert.match(lastMail(s, 'lata@example.com').subject, /has not received/);
    assert.deepEqual((await needs(s, 'lata')).map((n) => [n.kind, n.entryId]), [['fix_contribution', first]]);
    const fixed = await s.call('lata', 'PATCH', `/contributions/${first}`, { amount: '150' });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.deepEqual([fixed.body.contribution.status, fixed.body.contribution.amountCents], ['sent', 15000]);
    assert.equal((await s.call('ravi', 'POST', `/contributions/${first}/confirm`)).status, 200);
    assert.match(lastMail(s, 'lata@example.com').subject, /confirmed your/);

    // Second payment funds the request; only confirmed money counts.
    const second = await lend(s.call, 'lata', 'ravi', id, 350);
    assert.ok(second);
    const funded = (await s.call('lata', 'GET', `/requests/${id}`)).body.request;
    assert.equal(funded.status, 'funded');
    assert.equal(funded.fundedCents, 50000);

    // Home shows the lending position.
    const lending = (await s.call('lata', 'GET', '/home')).body.myLending;
    assert.deepEqual([lending[0].myLentCents, lending[0].myOwedCents], [50000, 50000]);

    // Repayment in two instalments to this lender. She confirms each; the request becomes repaid.
    const pay = async (amount, utr) => {
      const r = await s.call('ravi', 'POST', `/requests/${id}/repayments`, { lenderId: lata.id, amount, utr });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual((await needs(s, 'lata')).filter((n) => n.kind === 'confirm_repayment').map((n) => n.entryId), [r.body.repayment.id]);
      const ok = await s.call('lata', 'POST', `/repayments/${r.body.repayment.id}/confirm`);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      return ok.body.request;
    };
    assert.equal((await pay('200', 'REPAY00001')).status, 'funded');
    assert.equal((await pay('300', 'REPAY00002')).status, 'repaid');

    // Trust history of the borrower (API) and the lender's statement.
    const trust = (await s.call('lata', 'GET', `/users/${await idOf(s.call, 'ravi')}`)).body.user.trust;
    assert.deepEqual([trust.repaidCount, trust.repaidOnTimeCount], [1, 1]);
    const st = (await s.call('lata', 'GET', '/me/statement')).body;
    assert.deepEqual([st.loans[0].myLentCents, st.loans[0].myRepaidCents, st.loans[0].myOwedCents], [50000, 50000, 0]);
    assert.equal(st.loans[0].entries.length, 4);
    // Nothing owed any more, nothing waiting: the lender may leave.
    assert.equal((await s.call('lata', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
  } finally { await s.close(); }
});

test('lender: only mutual connections can see or fund a request, and over-sending is refused', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    await s.call('zed', 'GET', '/me');
    await s.call('zed', 'POST', '/follows', { userId: await idOf(s.call, 'ravi') }); // one-way follow only
    assert.equal((await s.call('zed', 'GET', `/requests/${id}`)).status, 404);
    assert.equal((await s.call('zed', 'POST', `/requests/${id}/contributions`, { amount: '100' })).status, 404);
    assert.equal((await s.call('lata', 'POST', `/requests/${id}/contributions`, { amount: '501' })).status, 409);
    assert.equal((await s.call('lata', 'POST', `/requests/${id}/contributions`, { amount: '100', utr: 'bad' })).status, 400);
    assert.equal((await s.call('ravi', 'POST', `/requests/${id}/contributions`, { amount: '100' })).status, 409);
  } finally { await s.close(); }
});

test('lender: withdraw or close leaves the lender with a "sent" entry; they are emailed and can remove it', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    await connect(s.call, 'ravi', 'mira');
    const stale = await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    // Withdraw: allowed while nothing is confirmed.
    assert.equal((await s.call('ravi', 'POST', `/requests/${id}/withdraw`)).status, 200);
    assert.match(lastMail(s, 'lata@example.com').subject, /withdrawn/);
    assert.equal((await s.call('ravi', 'POST', `/contributions/${stale}/confirm`)).status, 409);
    // The "sent" entry still blocks account deletion until the lender removes it.
    assert.equal((await s.call('lata', 'DELETE', '/me', { confirm: 'DELETE' })).status, 409);
    assert.equal((await s.call('lata', 'DELETE', `/contributions/${stale}`)).status, 200);
    assert.equal((await s.call('lata', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    // Close early: a second request, one lender confirmed, one still "sent".
    const id2 = await openRequest(s, { borrower: 'tara', contact: 'uma' });
    await connect(s.call, 'tara', 'mira');
    await connect(s.call, 'tara', 'nina');
    await lend(s.call, 'mira', 'tara', id2, 100);
    const left = await lend(s.call, 'nina', 'tara', id2, 100, { confirm: false });
    const closed = await s.call('tara', 'POST', `/requests/${id2}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.request.fundedCents, 10000);
    assert.match(lastMail(s, 'nina@example.com').subject, /closed/);
    assert.equal((await s.call('nina', 'DELETE', `/contributions/${left}`)).status, 200);
  } finally { await s.close(); }
});

test('lender: account deletion is blocked while money is owed to them', async () => {
  const s = await setup();
  try {
    await fundedRequest(s);
    const r = await s.call('lata', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /still owed money/);
  } finally { await s.close(); }
});

test('lender: a payment waiting 7 days reaches the owner queue, and the owner can settle it with a note', async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    const cid = await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    assert.deepEqual((await s.call('boss', 'GET', '/admin/stuck')).body.entries, [], 'fresh entries are not stuck');
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const stuck = (await s.call('boss', 'GET', '/admin/stuck')).body.entries;
    assert.deepEqual(stuck.map((e) => [e.kind, e.id, e.daysWaiting]), [['contribution', cid, 8]]);
    assert.equal((await s.call('boss', 'POST', `/admin/contributions/${cid}/settle`, { action: 'confirm', note: 'ok' })).status, 400);
    const done = await s.call('boss', 'POST', `/admin/contributions/${cid}/settle`, { action: 'confirm', note: 'Checked with both on WhatsApp' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'confirmed');
    assert.equal((await s.call('lata', 'GET', `/requests/${id}`)).body.request.totals.confirmedCents, 10000);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// VERIFIER: end to end
// ---------------------------------------------------------------------------------------------------------------

test('verifier journey: appointed, sees a non-mutual request, cannot verify own or as contact, two approvals open, one rejection closes, role removed', async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    const ids = {};
    for (const n of ['vee', 'wes', 'ravi', 'kiran', 'tara', 'uma', 'zed']) ids[n] = await idOf(s.call, n);

    // Appointed by the owner only.
    assert.equal((await s.call('vee', 'POST', `/admin/members/${ids.wes}/verifier`, { on: true })).status, 403);
    for (const n of ['vee', 'wes']) {
      const r = await s.call('boss', 'POST', `/admin/members/${ids[n]}/verifier`, { on: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.member.isVerifier, true);
    }

    // A request waits for verification. Verifiers see it without being connected; other members do not.
    const id = await startRequest(s.call, 'ravi', 'kiran');
    for (const v of ['vee', 'wes']) {
      assert.ok((await needs(s, v)).some((n) => n.kind === 'verify' && n.requestId === id && n.otherName === 'ravi'), `${v} sees it under Needs you`);
      assert.equal((await s.call(v, 'GET', `/requests/${id}`)).status, 200);
    }
    assert.equal((await s.call('zed', 'GET', `/requests/${id}`)).status, 404);

    // Not as the borrower, and not as the trusted contact.
    await s.repo.setVerifier(ids.ravi, true);
    await s.repo.setVerifier(ids.kiran, true);
    for (const n of ['ravi', 'kiran']) {
      const r = await s.call(n, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
      assert.equal(r.status, 403, n);
      assert.match(r.body.error, /own request/);
      assert.ok(!(await needs(s, n)).some((x) => x.kind === 'verify' && x.requestId === id), `${n} gets no verify item`);
    }

    // Reject needs a reason; the same verifier approving twice is still one approval; the second distinct approval opens it.
    const noReason = await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'reject', reason: 'no' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.field, 'reason');
    for (let i = 0; i < 2; i++) {
      const r = await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
      assert.equal(r.body.request.status, 'pending_verification');
    }
    assert.ok(!(await needs(s, 'vee')).some((n) => n.requestId === id), 'a verifier who decided no longer sees it under Needs you');
    const opened = await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(opened.body.request.status, 'open');
    assert.match(lastMail(s, 'ravi@example.com').subject, /approved/);

    // Another request: one approval, then a single rejection closes it. The reason is for the borrower.
    const id2 = await startRequest(s.call, 'tara', 'uma');
    await s.call('vee', 'POST', `/requests/${id2}/verify`, { decision: 'approve' });
    const rej = await s.call('wes', 'POST', `/requests/${id2}/verify`, { decision: 'reject', reason: 'The purpose is not clear to us' });
    assert.equal(rej.body.request.status, 'rejected');
    const seen = (await s.call('tara', 'GET', `/requests/${id2}`)).body.request;
    assert.equal(seen.rejectionReason, 'The purpose is not clear to us');
    assert.match(lastMail(s, 'tara@example.com').html, /The purpose is not clear to us/);
    assert.ok([403, 404].includes((await s.call('vee', 'POST', `/requests/${id2}/verify`, { decision: 'approve' })).status), 'closed requests cannot be decided again');

    // Removing the role: the member loses the queue and the ability to decide. The owner cannot remove their own role.
    assert.equal((await s.call('boss', 'POST', `/admin/members/${ids.vee}/verifier`, { on: false })).status, 200);
    const id3 = await startRequest(s.call, 'nina', 'omar');
    assert.ok([403, 404].includes((await s.call('vee', 'POST', `/requests/${id3}/verify`, { decision: 'approve' })).status), 'a removed verifier cannot decide');
    assert.equal((await s.call('vee', 'GET', `/requests/${id3}`)).status, 404);
    assert.ok(!(await needs(s, 'vee')).some((n) => n.requestId === id3));
    const self = await s.call('boss', 'POST', `/admin/members/${await idOf(s.call, 'boss')}/verifier`, { on: false });
    assert.equal(self.status, 409);
  } finally { await s.close(); }
});

test('verifier: the owner sees requests that cannot reach two approvals (fewer than two eligible verifiers)', async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    await makeVerifiers(s, 'vee');
    await s.repo.setVerifier(await idOf(s.call, 'boss'), false);
    const id = await startRequest(s.call, 'ravi', 'kiran');
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const gaps = (await s.call('boss', 'GET', '/admin/verification-gaps')).body.requests;
    assert.deepEqual(gaps.map((g) => [g.requestId, g.eligibleVerifiers, g.needed]), [[id, 1, 2]]);
    assert.equal((await s.call('ravi', 'GET', `/requests/${id}`)).body.request.status, 'pending_verification');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// GAPS (todo): each carries the assertions the fixed behaviour must meet
// ---------------------------------------------------------------------------------------------------------------

// Closed by the P-45 merge (G-06): the Requests tab lists open requests from the circle and links to #/feed.
test('lender can reach the circle feed from the app (Requests tab or Home lists open requests of mutual connections)', () => {
  const app = src('public/app.js');
  const wired = /Router\.register\('requests',\s*guarded\(renderFeed\)\)/.test(app)
    || /href="#\/feed"/.test(src('public/app/nav.js') + src('public/app/pages/home.js') + src('public/app/index.html'))
    || /Api\.get\('\/feed'\)/.test(src('public/app/pages/home.js'));
  assert.ok(wired, 'a lender can find open requests without typing the URL');
});

test('lender can correct (PATCH) or remove (DELETE) an entry the borrower marked not received, from the request page', { todo: 'gap: Home "Fix" opens a page with no edit or delete control' }, () => {
  const page = src('public/app/pages/request.js');
  assert.ok(/Api\.patch\([^)]*contributions/.test(page), 'edit amount or UTR');
  assert.ok(/Api\.delete\([^)]*contributions/.test(page), 'remove the entry');
  assert.ok(/Api\.patch\([^)]*repayments/.test(page), 'payer can edit a repayment too');
  assert.ok(/Api\.delete\([^)]*repayments/.test(page), 'payer can remove a repayment too');
});

test('after withdraw or close, the lender sees a Home item to remove their stale "sent" entry', { todo: 'gap: only an email says so; Home has no item and the page has no remove button' }, async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    const cid = await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    assert.equal((await s.call('ravi', 'POST', `/requests/${id}/withdraw`)).status, 200);
    const items = await needs(s, 'lata');
    assert.ok(items.some((n) => n.requestId === id && n.entryId === cid), 'stale sent entry is surfaced');
  } finally { await s.close(); }
});

test('only the people in a loan see "overdue"; other mutual connections see the plain funded status (anti-shaming)', { todo: 'gap: feed and detail show status overdue and daysOverdue to every mutual connection' }, async () => {
  const s = await setup();
  try {
    const { id } = await fundedRequest(s);
    await connect(s.call, 'ravi', 'zed'); // a mutual connection who is not a lender
    s.setNow(new Date('2027-02-10T12:00:00Z'));
    const feed = (await s.call('zed', 'GET', '/feed')).body.requests.find((r) => r.id === id);
    const detail = (await s.call('zed', 'GET', `/requests/${id}`)).body.request;
    assert.equal(feed.status, 'funded');
    assert.equal(detail.status, 'funded');
    assert.equal(detail.daysOverdue, 0);
    // The borrower and the lender still see it.
    assert.equal((await s.call('ravi', 'GET', `/requests/${id}`)).body.request.status, 'overdue');
    assert.equal((await s.call('lata', 'GET', `/requests/${id}`)).body.request.status, 'overdue');
  } finally { await s.close(); }
});

test('lender and borrower can ask the owner for help on an entry stuck 7+ days (POST /contributions/:id/help)', { todo: 'gap: spec 5.5a / P-34 route missing; members can only use the generic Get help form' }, async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    const cid = await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const asked = await s.call('lata', 'POST', `/contributions/${cid}/help`);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const row = (await s.call('boss', 'GET', '/admin/stuck')).body.entries.find((e) => e.id === cid);
    assert.ok(row.helpRequestedAt, 'the owner sees that help was asked');
    // Too early is refused.
    const fresh = await lend(s.call, 'lata', 'ravi', id, 50, { confirm: false });
    assert.equal((await s.call('lata', 'POST', `/contributions/${fresh}/help`)).status, 409);
  } finally { await s.close(); }
});

test('the same ask-the-owner route exists for repayments (POST /repayments/:id/help)', { todo: 'gap: route missing' }, async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    const { id } = await fundedRequest(s);
    const rep = await s.call('ravi', 'POST', `/requests/${id}/repayments`, { lenderId: await idOf(s.call, 'lata'), amount: '100' });
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const asked = await s.call('lata', 'POST', `/repayments/${rep.body.repayment.id}/help`);
    assert.equal(asked.status, 200);
  } finally { await s.close(); }
});

test('an entry waiting 7+ days is flagged to its lender in the request detail (proposed field waitingDays)', { todo: 'gap: P-34 "Waiting 7+ days" label has no data or UI' }, async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const c = (await s.call('lata', 'GET', `/requests/${id}`)).body.request.contributions[0];
    assert.ok(c.waitingDays >= 7, `waitingDays was ${c.waitingDays}`);
  } finally { await s.close(); }
});

test('an owner settlement shows in the request timeline and emails both sides', { todo: 'gap: settled note and owner name are not in the detail JSON and no settlement email is sent' }, async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    const cid = await lend(s.call, 'lata', 'ravi', id, 100, { confirm: false });
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    s.sent.length = 0;
    assert.equal((await s.call('boss', 'POST', `/admin/contributions/${cid}/settle`, { action: 'confirm', note: 'Both confirmed on a call' })).status, 200);
    const c = (await s.call('lata', 'GET', `/requests/${id}`)).body.request.contributions[0];
    assert.equal(c.settledNote, 'Both confirmed on a call');
    assert.equal(c.settledByName, 'boss');
    assert.deepEqual(s.sent.map((m) => m.to).sort(), ['lata@example.com', 'ravi@example.com']);
  } finally { await s.close(); }
});

test('a lender can nudge the borrower on WhatsApp to confirm ("please confirm you received")', { todo: 'gap: request page has WhatsApp text only for overdue repayment reminders' }, () => {
  assert.ok(/please confirm you received/i.test(src('public/app/pages/request.js')));
});

test('a lender sees the borrower\'s trust history (member since, repaid, repaid on time) before lending', { todo: 'gap: API returns trust for mutual connections but only the own profile page renders it' }, () => {
  const page = src('public/app/pages/request.js') + src('public/app/pages/circle.js');
  assert.ok(/\.trust\b|trustHtml|Trust history/.test(page));
});

test('the borrower proposes a new due date and each lender who is owed money votes (Phase C, P-28)', { todo: 'gap: no code; date_changes tables exist in migration 0002 only' }, async () => {
  const s = await setup();
  try {
    const { id } = await fundedRequest(s);
    const proposed = await s.call('ravi', 'POST', `/requests/${id}/date-changes`, { date: '2027-03-01' });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    assert.match(lastMail(s, 'lata@example.com').subject, /date/i);
    const vote = await s.call('lata', 'POST', `/date-changes/${proposed.body.dateChange.id}/vote`, { decision: 'accept' });
    assert.equal(vote.status, 200);
    const r = (await s.call('lata', 'GET', `/requests/${id}`)).body.request;
    assert.equal(r.repaymentDate, '2027-03-01');
    assert.equal(r.originalRepaymentDate, '2027-02-01');
  } finally { await s.close(); }
});

test('one declined vote ends the proposal and the due date stays (Phase C, P-28)', { todo: 'gap: no code' }, async () => {
  const s = await setup();
  try {
    const { id } = await fundedRequest(s);
    const proposed = await s.call('ravi', 'POST', `/requests/${id}/date-changes`, { date: '2027-03-01' });
    assert.equal(proposed.status, 201);
    assert.equal((await s.call('lata', 'POST', `/date-changes/${proposed.body.dateChange.id}/vote`, { decision: 'decline' })).status, 200);
    assert.equal((await s.call('lata', 'GET', `/requests/${id}`)).body.request.repaymentDate, '2027-02-01');
  } finally { await s.close(); }
});

test('the borrower posts a thank-you note; lenders are emailed unless they switched thank-yous off (Phase C, P-25, P-40)', { todo: 'gap: no code; email preference is stored but nothing reads it' }, async () => {
  const s = await setup();
  try {
    const { id } = await fundedRequest(s);
    const note = await s.call('ravi', 'POST', `/requests/${id}/notes`, { body: 'Thank you all, the fees are paid.' });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.match(lastMail(s, 'lata@example.com').subject, /thank/i);
    assert.ok((await s.call('lata', 'GET', `/requests/${id}`)).body.request.notes.some((n) => /fees are paid/.test(n.body)));
    await s.call('lata', 'PATCH', '/me/email-preferences', { reminders: true, thanks: false });
    s.sent.length = 0;
    await s.call('ravi', 'POST', `/requests/${id}/notes`, { body: 'One more thank you.' });
    assert.equal(s.sent.filter((m) => m.to === 'lata@example.com').length, 0);
  } finally { await s.close(); }
});

test('a lender gets a printable receipt for a request; outsiders get 404 (Phase C, P-25)', { todo: 'gap: GET /requests/:id/receipt does not exist' }, async () => {
  const s = await setup();
  try {
    const { id } = await fundedRequest(s);
    const r = await s.call('lata', 'GET', `/requests/${id}/receipt`);
    assert.equal(r.status, 200);
    assert.equal((await s.call('zed', 'GET', `/requests/${id}/receipt`)).status, 404);
  } finally { await s.close(); }
});

test('the daily job emails due reminders (7 and 1 day before, day after) once a day and closes lapsed open requests (Phase C, P-11, P-28, P-33)', { todo: 'gap: no GET /cron/daily, no vercel cron, no reminder code' }, async () => {
  const s = await setup();
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'journey-secret';
  try {
    const { id } = await fundedRequest(s);
    s.setNow(new Date('2027-01-25T04:00:00Z')); // 7 days before 2027-02-01
    const headers = { authorization: 'Bearer journey-secret' };
    s.sent.length = 0;
    const first = await s.call(null, 'GET', '/cron/daily', undefined, undefined, headers);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(s.sent.map((m) => m.to).sort(), ['kiran@example.com', 'ravi@example.com']);
    s.sent.length = 0;
    await s.call(null, 'GET', '/cron/daily', undefined, undefined, headers);
    assert.equal(s.sent.length, 0, 'safe to run twice');
    assert.equal((await s.call(null, 'GET', '/cron/daily', undefined, undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.ok(id);
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
    await s.close();
  }
});

test('an open request that reaches its due date closes at the confirmed amount, or is withdrawn if nothing was confirmed (Phase C, P-33)', { todo: 'gap: same missing daily job' }, async () => {
  const s = await setup();
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'journey-secret';
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    s.setNow(new Date('2027-02-02T04:00:00Z'));
    await s.call(null, 'GET', '/cron/daily', undefined, undefined, { authorization: 'Bearer journey-secret' });
    assert.equal((await s.call('ravi', 'GET', `/requests/${id}`)).body.request.status, 'withdrawn');
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
    await s.close();
  }
});

test('every email carries a plain-text part and a link to the request', { todo: 'gap: emails are html only and link to /app/, not the request' }, async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await connect(s.call, 'ravi', 'lata');
    s.sent.length = 0;
    await s.call('lata', 'POST', `/requests/${id}/contributions`, { amount: '100' });
    const mail = lastMail(s, 'ravi@example.com');
    assert.equal(typeof mail.text, 'string');
    assert.ok(mail.text.length > 10);
    assert.ok(mail.html.includes(`#/request/${id}`), 'deep link to the request');
  } finally { await s.close(); }
});

test('production email sending sits behind EMAIL_ENABLED, default off, and logs without addresses', { todo: 'gap: services.js sends whenever RESEND_API_KEY is set' }, () => {
  assert.ok(/EMAIL_ENABLED/.test(src('src/services.js')));
});

test('verifiers are told by email when a request starts waiting for them', { todo: 'gap: verifiers learn only by opening Home' }, async () => {
  const s = await setup();
  try {
    await makeVerifiers(s, 'vee', 'wes');
    s.sent.length = 0;
    await startRequest(s.call, 'ravi', 'kiran');
    const to = s.sent.map((m) => m.to);
    assert.ok(to.includes('vee@example.com') && to.includes('wes@example.com'));
  } finally { await s.close(); }
});

test('the borrower sees "Waiting for the verification team" when fewer than two verifiers are eligible (proposed field waitingForVerificationTeam)', { todo: 'gap: only the admin Gaps tab knows; the borrower sees "Two approvals are needed"' }, async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    await s.repo.setVerifier(await idOf(s.call, 'boss'), false);
    await makeVerifiers(s, 'vee');
    const id = await startRequest(s.call, 'ravi', 'kiran');
    assert.equal((await s.call('ravi', 'GET', `/requests/${id}`)).body.request.waitingForVerificationTeam, true);
  } finally { await s.close(); }
});

test('an approval from a member who is no longer a verifier does not count toward the two', { todo: 'gap: verificationOutcome counts stored decisions, not current verifier status' }, async () => {
  const s = await setup({ ownerEmail: 'boss@example.com' });
  try {
    await s.call('boss', 'GET', '/me');
    await makeVerifiers(s, 'vee', 'wes');
    await s.repo.setVerifier(await idOf(s.call, 'boss'), false);
    const id = await startRequest(s.call, 'ravi', 'kiran');
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('boss', 'POST', `/admin/members/${await idOf(s.call, 'vee')}/verifier`, { on: false }).catch(() => {});
    await s.repo.setVerifier(await idOf(s.call, 'vee'), false);
    const r = await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(r.body.request.status, 'pending_verification');
  } finally { await s.close(); }
});

test('every request listed under a verifier\'s Roles in My activity can be opened by them', { todo: 'gap: Roles lists decided requests that the visibility rule then answers with 404' }, async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    const rows = (await s.call('vee', 'GET', '/activity')).body.roles.verifier;
    assert.ok(rows.some((r) => r.requestId === id));
    for (const r of rows) assert.equal((await s.call('vee', 'GET', `/requests/${r.requestId}`)).status, 200, `request ${r.requestId}`);
  } finally { await s.close(); }
});

test('the reject form asks for a reason (10 to 500 characters), not an "optional" note', { todo: 'gap: label says "Note (optional)" but Reject needs a reason and the failure is only a toast' }, () => {
  const page = src('public/app/pages/request.js');
  const label = /<label for="v-note">([^<]*)<\/label>/.exec(page)?.[1] ?? '';
  assert.ok(!/optional/i.test(label), `label is "${label}"`);
});
