'use strict';
// Production-readiness audit: BORROWER and TRUSTED CONTACT journeys, walked through the real API on the memory repo.
// Passing tests describe what works today. `todo` tests are gaps: they hold the assertions the fixed behaviour must
// meet and currently fail (node:test reports them as todo, not as failures). Remove `todo` when a gap is fixed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('../helpers/harness');
const { requestBody, idOf, connect, startRequest, lend } = require('../helpers/lifecycle');

const root = path.join(__dirname, '..', '..');
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// Static check of source text without dumping the whole file into a failure message.
const has = (re, ...files) => assert.ok(re.test(files.map(source).join('\n')), `expected ${re} in ${files.join(', ')}`);
const DAY = 86400000;

/** A running app with the owner (admin and verifier) and a second verifier, 'vera'. Everyone else joins on demand. */
async function world({ inviteOnly = false } = {}) {
  const s = await setup({ ownerEmail: 'owner@example.com', admitAll: !inviteOnly });
  const { call } = s;
  const id = {};
  const join = async (name) => {
    if (inviteOnly && name !== 'owner') {
      const made = await call('owner', 'POST', '/invites', { email: `${name}@example.com` });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      await call(name, 'GET', '/me', null, null, { 'x-invite-token': made.body.link.split('#join=')[1] });
    }
    id[name] = await idOf(call, name);
    return id[name];
  };
  await join('owner');
  await join('vera');
  await call('owner', 'POST', `/admin/members/${id.vera}/verifier`, { on: true });
  return { s, call, id, join };
}

/** Both verifiers approve: the request becomes open. */
async function approve(call, requestId) {
  for (const v of ['owner', 'vera']) {
    const r = await call(v, 'POST', `/requests/${requestId}/verify`, { decision: 'approve' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

/** Borrower -> contact accepts -> verified -> open. Lenders are connected to the borrower. */
async function openRequest(w, borrower, contact, lenders = [], extra = {}) {
  for (const n of [borrower, contact, ...lenders]) if (!w.id[n]) await w.join(n);
  for (const l of lenders) await connect(w.call, borrower, l);
  const id = await startRequest(w.call, borrower, contact, extra);
  await approve(w.call, id);
  return id;
}

const repay = async (call, payer, requestId, lenderId, amount) => {
  const r = await call(payer, 'POST', `/requests/${requestId}/repayments`, { lenderId, amount });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.repayment.id;
};

// ---------------------------------------------------------------------------------------------------------------
// WORKS: one end-to-end test per journey
// ---------------------------------------------------------------------------------------------------------------

test('borrower journey: invited, welcome, request, consent, verification, funding, instalments, repaid, trust history, statement', async () => {
  const w = await world({ inviteOnly: true });
  const { s, call, id } = w;
  try {
    // Invited by link: joins connected with the inviter, then the welcome steps.
    await w.join('priya');
    const me = await call('priya', 'GET', '/me');
    assert.equal(me.body.user.inviterName, 'owner');
    assert.equal(me.body.user.termsAcceptedAt, null);
    assert.equal((await call('priya', 'PATCH', '/me', { upiId: 'priya@okbank' })).status, 200);
    assert.ok((await call('priya', 'POST', '/me/accept-terms')).body.user.termsAcceptedAt);
    assert.ok((await call('priya', 'POST', '/me/welcomed')).body.user.welcomedAt);
    for (const n of ['ravi', 'anil', 'meera']) await w.join(n);

    // Limits: Rs 100 to Rs 50,000, within 12 months, category required, contact must be a mutual connection.
    await connect(call, 'priya', 'ravi');
    await connect(call, 'priya', 'anil');
    await connect(call, 'priya', 'meera');
    const bad = async (extra, field) => {
      const r = await call('priya', 'POST', '/requests', requestBody(id.ravi, { amount: 5000, ...extra }));
      assert.equal(r.status, 400, field);
      assert.equal(r.body.field, field);
    };
    await bad({ amount: 99 }, 'amount');
    await bad({ amount: 50001 }, 'amount');
    await bad({ repaymentDate: '2027-11-21' }, 'repaymentDate');
    await bad({ category: 'holiday' }, 'category');
    const stranger = await call('priya', 'POST', '/requests', requestBody(id.vera, { amount: 5000 }));
    assert.equal(stranger.status, 409);

    // Request, then one active request at a time.
    const created = await call('priya', 'POST', '/requests', requestBody(id.ravi, { amount: 5000 }));
    assert.equal(created.status, 201);
    const rid = created.body.request.id;
    assert.equal(created.body.request.status, 'awaiting_contact');
    assert.equal((await call('priya', 'POST', '/requests', requestBody(id.ravi))).status, 409);

    // Trusted contact consent comes before verification.
    assert.ok(s.sent.some((m) => m.to === 'ravi@example.com' && /trusted contact/.test(m.subject)));
    assert.equal((await call('owner', 'POST', `/requests/${rid}/verify`, { decision: 'approve' })).status, 404, 'verifiers see it only after consent');
    const accepted = await call('ravi', 'POST', `/requests/${rid}/contact-decision`, { decision: 'accept' });
    assert.equal(accepted.body.request.status, 'pending_verification');

    // Verification: a borrower cannot verify; two approvals open it.
    assert.equal((await call('priya', 'POST', `/requests/${rid}/verify`, { decision: 'approve' })).status, 403);
    assert.equal((await call('owner', 'POST', `/requests/${rid}/verify`, { decision: 'approve' })).body.request.status, 'pending_verification');
    assert.equal((await call('vera', 'POST', `/requests/${rid}/verify`, { decision: 'approve' })).body.request.status, 'open');
    assert.ok(s.sent.some((m) => m.to === 'priya@example.com' && /approved/.test(m.subject)));

    // Funding: confirm, not received, lender corrects, confirm.
    const c1 = await lend(call, 'anil', 'priya', rid, 3000);
    const home1 = await call('priya', 'GET', '/home');
    assert.equal(home1.body.needsYou.filter((n) => n.kind === 'confirm_contribution').length, 0);
    const sent2 = await call('meera', 'POST', `/requests/${rid}/contributions`, { amount: 1000 });
    assert.equal((await call('priya', 'GET', '/home')).body.needsYou[0].kind, 'confirm_contribution');
    await call('priya', 'POST', `/contributions/${sent2.body.contribution.id}/not-received`);
    assert.equal((await call('priya', 'GET', '/home')).body.needsYou.length, 0);
    assert.equal((await call('meera', 'GET', '/home')).body.needsYou[0].kind, 'fix_contribution');
    const fixed = await call('meera', 'PATCH', `/contributions/${sent2.body.contribution.id}`, { amount: 2000, utr: 'UTR123456' });
    assert.equal(fixed.body.contribution.status, 'sent');
    assert.equal((await call('anil', 'POST', `/requests/${rid}/contributions`, { amount: 1 })).status, 409, 'cap: 5000 is fully pledged');
    assert.equal((await call('priya', 'POST', `/contributions/${sent2.body.contribution.id}/confirm`)).body.request.status, 'funded');
    assert.ok(c1);

    // Repay each lender in instalments, by UPI; over-paying is refused; repaid only when every lender is clear.
    assert.equal((await call('priya', 'GET', `/requests/${rid}`)).body.request.payTo.find((t) => t.userId === id.priya), undefined);
    const p1 = await repay(call, 'priya', rid, id.anil, 1000);
    assert.equal((await call('priya', 'POST', `/requests/${rid}/repayments`, { lenderId: id.anil, amount: 2500 })).status, 409);
    await call('anil', 'POST', `/repayments/${p1}/confirm`);
    for (const [lender, who, amt] of [[id.anil, 'anil', 2000], [id.meera, 'meera', 2000]]) {
      const pid = await repay(call, 'priya', rid, lender, amt);
      const done = await call(who, 'POST', `/repayments/${pid}/confirm`);
      assert.equal(done.body.request.status, who === 'meera' ? 'repaid' : 'funded');
    }

    // Trust history and statement show the facts.
    const trust = (await call('priya', 'GET', `/users/${id.priya}`)).body.user.trust;
    assert.equal(trust.repaidCount, 1);
    assert.equal(trust.repaidOnTimeCount, 1);
    const stmt = (await call('priya', 'GET', '/me/statement')).body;
    assert.equal(stmt.requests[0].paidBackCents, 500000);
    assert.equal((await call('anil', 'GET', '/me/statement')).body.loans[0].myRepaidCents, 300000);
  } finally { await s.close(); }
});

test('borrower journey: rejected with a reason (borrower only), then try again straight away', async () => {
  const w = await world();
  const { s, call, id } = w;
  try {
    await w.join('priya'); await w.join('ravi');
    const rid = await startRequest(call, 'priya', 'ravi');
    assert.equal((await call('vera', 'POST', `/requests/${rid}/verify`, { decision: 'reject', reason: 'no' })).status, 400);
    assert.equal((await call('vera', 'POST', `/requests/${rid}/verify`, { decision: 'reject' })).status, 400);
    const rejected = await call('vera', 'POST', `/requests/${rid}/verify`, { decision: 'reject', reason: 'Please add the college fee invoice' });
    assert.equal(rejected.body.request.status, 'rejected');
    assert.equal((await call('priya', 'GET', `/requests/${rid}`)).body.request.rejectionReason, 'Please add the college fee invoice');
    assert.equal((await call('ravi', 'GET', `/requests/${rid}`)).body.request.rejectionReason, undefined);
    assert.ok(s.sent.some((m) => m.to === 'priya@example.com' && /not approved/.test(m.subject)));
    // A rejected request no longer blocks a new one, and the contact is asked again.
    const again = await call('priya', 'POST', '/requests', requestBody(id.ravi, { purpose: 'School fees with the invoice attached this time' }));
    assert.equal(again.status, 201);
    assert.equal((await call('ravi', 'GET', '/home')).body.needsYou[0].kind, 'contact_decision');
  } finally { await s.close(); }
});

test('borrower journey: contact declines, borrower re-picks, withdraws, and the limits hold at their edges', async () => {
  const w = await world();
  const { call, s, id } = w;
  try {
    for (const n of ['priya', 'ravi', 'meera']) await w.join(n);
    await connect(call, 'priya', 'ravi'); await connect(call, 'priya', 'meera');
    const created = await call('priya', 'POST', '/requests', requestBody(id.ravi, { amount: 100 }));
    assert.equal(created.status, 201, 'Rs 100 is the minimum');
    const rid = created.body.request.id;
    assert.equal((await call('ravi', 'POST', `/requests/${rid}/contact-decision`, { decision: 'decline' })).body.request.status, 'contact_declined');
    assert.equal((await call('priya', 'GET', '/home')).body.needsYou[0].kind, 'repick_contact');
    assert.equal((await call('priya', 'POST', `/requests/${rid}/trusted-contact`, { userId: id.ravi })).status, 409);
    assert.equal((await call('priya', 'POST', `/requests/${rid}/trusted-contact`, { userId: id.meera })).body.request.status, 'awaiting_contact');
    await call('meera', 'POST', `/requests/${rid}/contact-decision`, { decision: 'accept' });
    const withdrawn = await call('priya', 'POST', `/requests/${rid}/withdraw`);
    assert.equal(withdrawn.body.request.status, 'withdrawn');
    const next = await call('priya', 'POST', '/requests', requestBody(id.meera, { amount: 50000, repaymentDate: '2027-11-20' }));
    assert.equal(next.status, 201, 'Rs 50,000 and exactly 12 months are the maximum');
    assert.ok(s.sent.length > 0);
  } finally { await s.close(); }
});

test('borrower journey: close early at the confirmed amount, overdue label, repay late, repaid', async () => {
  const w = await world();
  const { call, id } = w;
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil', 'meera'], { amount: 5000 });
    await lend(call, 'anil', 'priya', rid, 2000);
    const stray = await call('meera', 'POST', `/requests/${rid}/contributions`, { amount: 1000 });
    const closed = await call('priya', 'POST', `/requests/${rid}/close`);
    assert.equal(closed.body.request.status, 'funded');
    assert.equal(closed.body.request.fundedCents, 200000);
    assert.equal((await call('priya', 'POST', `/contributions/${stray.body.contribution.id}/confirm`)).status, 409);
    assert.equal((await call('meera', 'DELETE', `/contributions/${stray.body.contribution.id}`)).status, 200);
    w.s.setNow(new Date('2027-02-05T12:00:00Z'));
    const late = (await call('priya', 'GET', `/requests/${rid}`)).body.request;
    assert.equal(late.status, 'overdue');
    assert.equal(late.daysOverdue, 4);
    const pid = await repay(call, 'priya', rid, id.anil, 2000);
    assert.equal((await call('anil', 'POST', `/repayments/${pid}/confirm`)).body.request.status, 'repaid');
    const trust = (await call('priya', 'GET', `/users/${id.priya}`)).body.user.trust;
    assert.equal(trust.repaidOnTimeCount, 0, 'repaid after the due date does not count as on time');
  } finally { await w.s.close(); }
});

test('borrower journey: get help, and delete the account once nothing is active', async () => {
  const w = await world();
  const { call, id } = w;
  try {
    await w.join('priya'); await w.join('ravi');
    assert.equal((await call('priya', 'POST', '/help', { body: 'short' })).status, 400);
    assert.equal((await call('priya', 'POST', '/help', { body: 'How do I change my UPI ID?' })).status, 201);
    assert.equal((await call('priya', 'GET', '/help/mine')).body.messages.length, 1);
    const rid = await startRequest(call, 'priya', 'ravi');
    assert.equal((await call('priya', 'DELETE', '/me', { confirm: 'nope' })).status, 400);
    assert.equal((await call('priya', 'DELETE', '/me', { confirm: 'DELETE' })).status, 409, 'active request blocks deletion');
    await call('priya', 'POST', `/requests/${rid}/withdraw`);
    assert.equal((await call('priya', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    assert.equal((await call('owner', 'GET', `/users/${id.priya}`)).body.user.name, 'Former member');
  } finally { await w.s.close(); }
});

test('trusted contact journey: notified, views, accepts, records a repayment on the borrower\'s behalf, deletion blocked while active', async () => {
  const w = await world();
  const { s, call, id } = w;
  try {
    for (const n of ['priya', 'ravi', 'anil']) await w.join(n);
    await connect(call, 'priya', 'ravi'); await connect(call, 'priya', 'anil');
    const created = await call('priya', 'POST', '/requests', requestBody(id.ravi, { amount: 2000 }));
    const rid = created.body.request.id;
    assert.ok(s.sent.some((m) => m.to === 'ravi@example.com'), 'contact is emailed');
    assert.equal((await call('ravi', 'GET', '/home')).body.needsYou[0].kind, 'contact_decision');
    assert.equal((await call('ravi', 'GET', `/requests/${rid}`)).status, 200, 'contact can read the request');
    assert.equal((await call('anil', 'GET', `/requests/${rid}`)).status, 404, 'a lender-to-be cannot see it before it is open');
    assert.equal((await call('priya', 'POST', `/requests/${rid}/contact-decision`, { decision: 'accept' })).status, 403);
    assert.equal((await call('ravi', 'DELETE', '/me', { confirm: 'DELETE' })).status, 409, 'blocked while named on an active request');
    await call('ravi', 'POST', `/requests/${rid}/contact-decision`, { decision: 'accept' });
    assert.equal((await call('ravi', 'POST', `/requests/${rid}/contact-decision`, { decision: 'accept' })).status, 409, 'answer once');
    await approve(call, rid);
    await lend(call, 'anil', 'priya', rid, 2000);
    assert.equal((await call('ravi', 'POST', `/requests/${rid}/repayments`, { lenderId: id.anil, amount: 3000 })).status, 409, 'cannot overpay');
    const pid = await repay(call, 'ravi', rid, id.anil, 2000);
    assert.equal((await call('anil', 'GET', '/home')).body.needsYou[0].kind, 'confirm_repayment');
    assert.equal((await call('anil', 'POST', `/repayments/${pid}/confirm`)).body.request.status, 'repaid');
    assert.equal((await call('ravi', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200, 'free to leave once repaid');
  } finally { await s.close(); }
});

test('trusted contact journey: at most 3 active requests, and a slot frees on withdrawal', async () => {
  const w = await world();
  const { call, id } = w;
  try {
    await w.join('ravi');
    const borrowers = ['b1', 'b2', 'b3', 'b4'];
    for (const b of borrowers) { await w.join(b); await connect(call, b, 'ravi'); }
    const ids = [];
    for (const b of borrowers.slice(0, 3)) {
      const r = await call(b, 'POST', '/requests', requestBody(id.ravi));
      assert.equal(r.status, 201);
      ids.push(r.body.request.id);
    }
    const fourth = await call('b4', 'POST', '/requests', requestBody(id.ravi));
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.field, 'trustedContactId');
    await call('b1', 'POST', `/requests/${ids[0]}/withdraw`);
    assert.equal((await call('b4', 'POST', '/requests', requestBody(id.ravi))).status, 201);
  } finally { await w.s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// GAPS: todo tests. Each holds the real assertion the fixed behaviour must meet.
// ---------------------------------------------------------------------------------------------------------------

test('trusted contact never answers for 7 days: borrower may pick someone else', { todo: 'gap: re-pick only allowed after a decline (src/app.js:763), no 7-day timeout (spec 5.1)' }, async () => {
  const w = await world();
  try {
    await w.join('priya'); await w.join('ravi'); await w.join('meera');
    await connect(w.call, 'priya', 'ravi'); await connect(w.call, 'priya', 'meera');
    const rid = (await w.call('priya', 'POST', '/requests', requestBody(w.id.ravi))).body.request.id;
    w.s.setNow(new Date(new Date('2026-11-20T12:00:00Z').getTime() + 8 * DAY));
    const r = await w.call('priya', 'POST', `/requests/${rid}/trusted-contact`, { userId: w.id.meera });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'awaiting_contact');
  } finally { await w.s.close(); }
});

test('a contact who declined can delete their account without waiting for the borrower', { todo: 'gap: contact_declined still counts as active for the decliner (countActiveAsContact), blocking deletion and using a slot' }, async () => {
  const w = await world();
  try {
    await w.join('priya'); await w.join('ravi');
    await connect(w.call, 'priya', 'ravi');
    const id = (await w.call('priya', 'POST', '/requests', requestBody(w.id.ravi))).body.request.id;
    await w.call('ravi', 'POST', `/requests/${id}/contact-decision`, { decision: 'decline' });
    const del = await w.call('ravi', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  } finally { await w.s.close(); }
});

test('borrower is emailed when the trusted contact accepts or declines', { todo: 'gap: contact-decision sends no email (src/app.js:745-757)' }, async () => {
  const w = await world();
  try {
    await w.join('priya'); await w.join('ravi');
    await connect(w.call, 'priya', 'ravi');
    const id = (await w.call('priya', 'POST', '/requests', requestBody(w.id.ravi))).body.request.id;
    await w.call('ravi', 'POST', `/requests/${id}/contact-decision`, { decision: 'decline' });
    assert.ok(w.s.sent.some((m) => m.to === 'priya@example.com' && /ravi|trusted contact|declined/i.test(m.subject)), 'borrower hears the answer');
  } finally { await w.s.close(); }
});

test('an accepted request shows up for the trusted contact on Home', { todo: 'gap: GET /home lists only requests the member borrowed or lent to (src/app.js:574-630), so a contact cannot find the request after accepting' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', []);
    const home = (await w.call('ravi', 'GET', '/home')).body;
    const found = Object.entries(home).some(([k, v]) => k !== 'needsYou' && JSON.stringify(v).includes(`"id":${rid}`));
    assert.ok(found, 'contact sees the request they stand behind');
  } finally { await w.s.close(); }
});

test('an open request past its due date refuses new contributions', { todo: 'gap: no due-date check in rules.checkContribution and no auto-close (spec 5.1, P-33)' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil'], { amount: 5000 });
    w.s.setNow(new Date('2027-02-10T12:00:00Z'));
    const r = await w.call('anil', 'POST', `/requests/${rid}/contributions`, { amount: 500 });
    assert.equal(r.status, 409, 'closed on its due date');
  } finally { await w.s.close(); }
});

test('daily cron closes part-funded requests, withdraws unfunded ones and sends reminders', { todo: 'gap: no GET /cron/daily route and no crons entry in vercel.json (spec section 7)' }, () => {
  has(/cron\/daily/, 'src/app.js');
  has(/"crons"/, 'vercel.json');
});

test('email sending is behind an EMAIL_ENABLED switch that defaults to off', { todo: 'gap: only RESEND_API_KEY gates sending (src/services.js:38); no EMAIL_ENABLED (spec 7, checklist section 4)' }, () => {
  has(/EMAIL_ENABLED/, 'src/services.js', 'src/config.js');
});

test('borrower can propose a new due date on a funded or overdue request', { todo: 'gap: Phase C date-changes not built; POST /requests/:id/date-changes returns 404 (spec 5.5)' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil'], { amount: 1000 });
    await lend(w.call, 'anil', 'priya', rid, 1000);
    w.s.setNow(new Date('2027-02-05T12:00:00Z'));
    const r = await w.call('priya', 'POST', `/requests/${rid}/date-changes`, { date: '2027-03-01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally { await w.s.close(); }
});

test('borrower can post a thank-you note once a contribution is confirmed', { todo: 'gap: Phase C notes not built; POST /requests/:id/notes returns 404 (spec 5.9)' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil'], { amount: 1000 });
    await lend(w.call, 'anil', 'priya', rid, 500);
    const r = await w.call('priya', 'POST', `/requests/${rid}/notes`, { body: 'Thank you all for helping with the fees' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally { await w.s.close(); }
});

test('a receipt is available to the borrower, trusted contact and lenders', { todo: 'gap: Phase C receipt not built; GET /requests/:id/receipt returns 404 (spec 5.10)' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil'], { amount: 1000 });
    await lend(w.call, 'anil', 'priya', rid, 1000);
    for (const who of ['priya', 'ravi', 'anil']) assert.equal((await w.call(who, 'GET', `/requests/${rid}/receipt`)).status, 200, who);
  } finally { await w.s.close(); }
});

test('a stuck contribution can be sent to the owner with "Ask the owner to help"', { todo: 'gap: POST /contributions/:id/help not built (spec 5.5a, section 7)' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil'], { amount: 1000 });
    const c = await w.call('anil', 'POST', `/requests/${rid}/contributions`, { amount: 500 });
    w.s.setNow(new Date('2026-11-29T12:00:00Z'));
    const r = await w.call('priya', 'POST', `/contributions/${c.body.contribution.id}/help`);
    assert.ok([200, 201].includes(r.status), `status ${r.status}`);
  } finally { await w.s.close(); }
});

test('closing or withdrawing voids leftover "sent" entries so they cannot block account deletion later', { todo: 'gap: stale sent contributions stay sent after close (src/app.js:818-828) and count as unsettled in DELETE /me' }, async () => {
  const w = await world();
  try {
    const rid = await openRequest(w, 'priya', 'ravi', ['anil', 'meera'], { amount: 5000 });
    await lend(w.call, 'anil', 'priya', rid, 2000);
    await w.call('meera', 'POST', `/requests/${rid}/contributions`, { amount: 500 });
    await w.call('priya', 'POST', `/requests/${rid}/close`);
    const pid = await repay(w.call, 'priya', rid, w.id.anil, 2000);
    await w.call('anil', 'POST', `/repayments/${pid}/confirm`);
    const del = await w.call('priya', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  } finally { await w.s.close(); }
});

// ---- Front end gaps (static checks of the page source: the pages are plain browser scripts) ----

test('request page lets the borrower withdraw while it is withdrawable', { todo: 'gap: API exists (src/app.js:804) but public/app/pages/request.js has no withdraw control' }, () => {
  has(/\/withdraw/, 'public/app/pages/request.js');
});

test('request page lets the borrower "Close with Rs X" on a part-funded open request', { todo: 'gap: API exists (src/app.js:818) but request.js has no close control' }, () => {
  has(/\/close/, 'public/app/pages/request.js');
});

test('request page lets the borrower pick another trusted contact after a decline', { todo: 'gap: API exists (src/app.js:759) but no page calls /trusted-contact; Home links to a page with no picker' }, () => {
  has(/trusted-contact/, 'public/app/pages/request.js');
});

test('a rejected request offers "Try again" with the form prefilled', { todo: 'gap: rejection reason is plain red text; no Try again button or prefill (spec 5.2, P-39)' }, () => {
  has(/Try again/, 'public/app/pages/request.js', 'public/app/pages/new-request.js');
});

test('a lender can correct or remove an entry the borrower marked not received', { todo: 'BROKEN: Home says "Fix" but the request page has no edit or delete control, so PATCH/DELETE on contributions and repayments are unreachable' }, () => {
  has(/Api\.patch\(`\/(contributions|repayments)/, 'public/app/pages/request.js');
  has(/Api\.delete\(`\/(contributions|repayments)/, 'public/app/pages/request.js');
});

test('rejecting needs a visible reason field (10 to 500 characters), not an optional note', { todo: 'gap: verify form labels the reason "Note (optional)" with maxlength 1000, but the API requires 10-500 to reject (request.js:147)' }, () => {
  assert.doesNotMatch(source('public/app/pages/request.js'), /Note \(optional\)/);
  has(/maxlength="500"/, 'public/app/pages/request.js');
});

test('trusted-contact picker copy matches the terms: a contact is not a guarantor', { todo: 'gap: new-request.js says "They help repay if you cannot" but legal.js says a contact has no obligation to repay' }, () => {
  assert.doesNotMatch(source('public/app/pages/new-request.js'), /help repay/i);
});

test('lenders get the WhatsApp reminder button on an overdue request, not only borrower and contact', { todo: 'gap: wa-reminder is shown only to isBorrower || isContact (request.js:138); P-24 wants the lender-side nudge' }, () => {
  has(/isLender/, 'public/app/pages/request.js');
});

test('entries waiting 7+ days show a "Waiting 7+ days" label with a WhatsApp nudge', { todo: 'gap: no stuck-entry UI for borrower or contact (spec 5.5a, P-34)' }, () => {
  has(/Waiting 7\+ days/, 'public/app/pages/request.js');
});

test('borrower sees "Waiting for the verification team" when fewer than two verifiers are eligible', { todo: 'gap: UI shows only "Awaiting verification" (spec 5.7a); only admin sees the gap' }, () => {
  has(/Waiting for the verification team/, 'public/app/pages/request.js', 'public/app/card-model.js');
});
