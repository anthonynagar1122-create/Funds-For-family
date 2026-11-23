'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { connect, startRequest, idOf, requestBody } = require('./helpers/lifecycle');

// Fixed clock so date rules are deterministic.


const validRequest = (nomineeId) => ({
  amount: 500,
  purpose: 'School fees for the second term at the local college',
  repaymentDate: '2027-02-01',
  category: 'education',
  trustedContactId: nomineeId,
});

test('requests without a signed-in user are rejected', async () => {
  const { call, close } = await setup();
  try {
    const r = await call(null, 'GET', '/me');
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('a member creates a request; it starts awaiting the trusted contact', async () => {
  const { call, close, sent } = await setup();
  try {
    await call('ann', 'GET', '/me');
    await call('ben', 'GET', '/me');
    await connect(call, 'ann', 'ben');
    const created = await call('ann', 'POST', '/requests', validRequest(2));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.request.status, 'awaiting_contact');
    assert.equal(created.body.request.principalCents, 50000);
    assert.equal(sent.at(-1).to, 'ben@example.com');
    assert.equal(sent.at(-1).subject, 'ann named you as their trusted contact');
    assert.match(sent.at(-1).html, /₹500\.00/);
  } finally { await close(); }
});

test('trusted contact must exist and cannot be the borrower', async () => {
  const { call, close } = await setup();
  try {
    await call('ann', 'GET', '/me');
    const self = await call('ann', 'POST', '/requests', validRequest(1));
    assert.equal(self.status, 400);
    assert.equal(self.body.field, 'trustedContactId');
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

    const id = await startRequest(call, 'ann', 'nat');

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

    const id = await startRequest(call, 'ann', 'nat');
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

test('repayment by the trusted contact closes the request once the principal is repaid (no interest)', async () => {
  const { repo, call, close } = await setup();
  try {
    const nat = (await call('nat', 'GET', '/me')).body.user;
    await call('ann', 'GET', '/me');
    const vee = (await call('vee', 'GET', '/me')).body.user;
    const wes = (await call('wes', 'GET', '/me')).body.user;
    await repo.setVerifier(vee.id, true);
    await repo.setVerifier(wes.id, true);
    const id = await startRequest(call, 'ann', 'nat');
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
    const id = await startRequest(call, 'ann', 'nat');

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
    assert.match(sent[0].html, /#join=/);
  } finally { await close(); }
});

// ---------- Request lifecycle: trusted-contact consent, reasons, withdraw, close ----------

const names = ['ann', 'nat', 'bea', 'cal', 'dee', 'eve', 'vee', 'wes', 'zed'];

async function people(ctx) {
  const ids = {};
  for (const n of names) ids[n] = await idOf(ctx.call, n);
  await ctx.repo.setVerifier(ids.vee, true);
  await ctx.repo.setVerifier(ids.wes, true);
  return ids;
}

const create = (ctx, borrower, contactId, extra) => ctx.call(borrower, 'POST', '/requests', requestBody(contactId, extra));

test('creating with a contact who is not a mutual connection is refused', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    await ctx.call('ann', 'POST', '/follows', { userId: ids.nat }); // one way only
    const r = await create(ctx, 'ann', ids.nat);
    assert.equal(r.status, 409);
    assert.equal(r.body.field, 'trustedContactId');
  } finally { await ctx.close(); }
});

test('a second request while one is awaiting the contact is refused', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    await connect(ctx.call, 'ann', 'nat');
    assert.equal((await create(ctx, 'ann', ids.nat)).status, 201);
    const again = await create(ctx, 'ann', ids.nat);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already have an active request/);
  } finally { await ctx.close(); }
});

test('a trusted contact cannot be named on a 4th active request', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    for (const b of ['ann', 'bea', 'cal']) {
      await connect(ctx.call, b, 'nat');
      assert.equal((await create(ctx, b, ids.nat)).status, 201);
    }
    await connect(ctx.call, 'dee', 'nat');
    const r = await create(ctx, 'dee', ids.nat);
    assert.equal(r.status, 409);
    assert.equal(r.body.field, 'trustedContactId');
  } finally { await ctx.close(); }
});

test('the trusted contact accepts; a stranger calling contact-decision gets 404', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    await connect(ctx.call, 'ann', 'nat');
    const id = (await create(ctx, 'ann', ids.nat)).body.request.id;
    const stranger = await ctx.call('zed', 'POST', `/requests/${id}/contact-decision`, { decision: 'accept' });
    assert.equal(stranger.status, 404);
    const borrower = await ctx.call('ann', 'POST', `/requests/${id}/contact-decision`, { decision: 'accept' });
    assert.equal(borrower.status, 403, 'can see it but is not the trusted contact');
    const bad = await ctx.call('nat', 'POST', `/requests/${id}/contact-decision`, { decision: 'maybe' });
    assert.equal(bad.status, 400);
    const ok = await ctx.call('nat', 'POST', `/requests/${id}/contact-decision`, { decision: 'accept' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.request.status, 'pending_verification');
    const again = await ctx.call('nat', 'POST', `/requests/${id}/contact-decision`, { decision: 'accept' });
    assert.equal(again.status, 409, 'no longer awaiting the contact');
  } finally { await ctx.close(); }
});

test('after a decline the borrower picks a new mutual contact and consent restarts', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    await connect(ctx.call, 'ann', 'nat');
    await connect(ctx.call, 'ann', 'bea');
    const id = (await create(ctx, 'ann', ids.nat)).body.request.id;
    const early = await ctx.call('ann', 'POST', `/requests/${id}/trusted-contact`, { userId: ids.bea });
    assert.equal(early.status, 409, 'only after a decline');
    const declined = await ctx.call('nat', 'POST', `/requests/${id}/contact-decision`, { decision: 'decline' });
    assert.equal(declined.body.request.status, 'contact_declined');
    const notMutual = await ctx.call('ann', 'POST', `/requests/${id}/trusted-contact`, { userId: ids.cal });
    assert.equal(notMutual.status, 409);
    assert.equal(notMutual.body.field, 'trustedContactId');
    const stranger = await ctx.call('zed', 'POST', `/requests/${id}/trusted-contact`, { userId: ids.bea });
    assert.equal(stranger.status, 404);
    const picked = await ctx.call('ann', 'POST', `/requests/${id}/trusted-contact`, { userId: ids.bea });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.equal(picked.body.request.status, 'awaiting_contact');
    assert.equal(picked.body.request.trustedContactId, ids.bea);
    assert.equal(ctx.sent.at(-1).to, 'bea@example.com');
  } finally { await ctx.close(); }
});

test('a rejection needs a reason; the borrower sees it, the trusted contact does not, and they can try again at once', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    const id = await startRequest(ctx.call, 'ann', 'nat');
    const none = await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'reject' });
    assert.equal(none.status, 400);
    assert.equal(none.body.field, 'reason');
    const reason = 'The purpose is not clear <b>enough</b> for us';
    const rej = await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'reject', reason });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(rej.body.request.status, 'rejected');
    assert.equal(rej.body.request.rejectionReason, undefined, 'not shown to the verifier');
    const mail = ctx.sent.at(-1);
    assert.equal(mail.to, 'ann@example.com');
    assert.equal(mail.subject, 'Your Funds For Family request was not approved');
    assert.match(mail.html, /&lt;b&gt;enough&lt;\/b&gt;/);
    assert.doesNotMatch(mail.html, /<b>enough/);

    const mine = await ctx.call('ann', 'GET', `/requests/${id}`);
    assert.equal(mine.body.request.rejectionReason, reason);
    const theirs = await ctx.call('nat', 'GET', `/requests/${id}`);
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.request.rejectionReason, undefined);
    assert.doesNotMatch(theirs.text, /not clear/, 'reason text is nowhere in the contact view');

    const retry = await create(ctx, 'ann', ids.nat);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
  } finally { await ctx.close(); }
});

test('approval emails the borrower with the amount in rupees', async () => {
  const ctx = await setup();
  try {
    await people(ctx);
    const id = await startRequest(ctx.call, 'ann', 'nat');
    await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await ctx.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const mail = ctx.sent.at(-1);
    assert.equal(mail.subject, 'Your Funds For Family request was approved');
    assert.match(mail.html, /₹500\.00/);
    assert.doesNotMatch(mail.html, /\$/);
  } finally { await ctx.close(); }
});

async function openWithContribution(ctx, amount) {
  await people(ctx);
  const id = await startRequest(ctx.call, 'ann', 'nat', { amount: 1000 });
  await ctx.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  await ctx.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  if (amount) {
    await connect(ctx.call, 'ann', 'bea');
    const c = await ctx.call('bea', 'POST', `/requests/${id}/contributions`, { amount });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  }
  return id;
}

test('withdraw works before any confirmed contribution and is refused after one', async () => {
  const ctx = await setup();
  try {
    const first = await openWithContribution(ctx, 0);
    const stranger = await ctx.call('zed', 'POST', `/requests/${first}/withdraw`);
    assert.equal(stranger.status, 404);
    const contact = await ctx.call('nat', 'POST', `/requests/${first}/withdraw`);
    assert.equal(contact.status, 403);
    const w = await ctx.call('ann', 'POST', `/requests/${first}/withdraw`);
    assert.equal(w.status, 200);
    assert.equal(w.body.request.status, 'withdrawn');
  } finally { await ctx.close(); }
  const ctx2 = await setup();
  try {
    const id = await openWithContribution(ctx2, 300);
    const w = await ctx2.call('ann', 'POST', `/requests/${id}/withdraw`);
    assert.equal(w.status, 409);
  } finally { await ctx2.close(); }
});

test('a request awaiting its contact can be withdrawn', async () => {
  const ctx = await setup();
  try {
    const ids = await people(ctx);
    await connect(ctx.call, 'ann', 'nat');
    const id = (await create(ctx, 'ann', ids.nat)).body.request.id;
    const w = await ctx.call('ann', 'POST', `/requests/${id}/withdraw`);
    assert.equal(w.body.request.status, 'withdrawn');
    assert.equal((await create(ctx, 'ann', ids.nat)).status, 201, 'a new request is allowed at once');
  } finally { await ctx.close(); }
});

test('close with ₹300 confirmed of ₹1,000 funds the request at ₹300', async () => {
  const ctx = await setup();
  try {
    const id = await openWithContribution(ctx, 300);
    const stranger = await ctx.call('zed', 'POST', `/requests/${id}/close`);
    assert.equal(stranger.status, 404);
    const lender = await ctx.call('bea', 'POST', `/requests/${id}/close`);
    assert.equal(lender.status, 403, 'a lender can see it but is not the borrower');
    const closed = await ctx.call('ann', 'POST', `/requests/${id}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.request.status, 'funded');
    assert.equal(closed.body.request.fundedCents, 30000);
    assert.equal(closed.body.request.principalCents, 100000);
    assert.ok(ctx.repo._state.requests.get(id).fundedAt);
    const again = await ctx.call('ann', 'POST', `/requests/${id}/close`);
    assert.equal(again.status, 409);
  } finally { await ctx.close(); }
});

test('close is refused with nothing confirmed', async () => {
  const ctx = await setup();
  try {
    const id = await openWithContribution(ctx, 0);
    const r = await ctx.call('ann', 'POST', `/requests/${id}/close`);
    assert.equal(r.status, 409);
  } finally { await ctx.close(); }
});

test('GET /requests/:id is 404 for a stranger and 200 for the people involved', async () => {
  const ctx = await setup();
  try {
    await people(ctx);
    const id = await startRequest(ctx.call, 'ann', 'nat');
    assert.equal((await ctx.call('zed', 'GET', `/requests/${id}`)).status, 404);
    assert.equal((await ctx.call('ann', 'GET', `/requests/${id}`)).status, 200);
    assert.equal((await ctx.call('nat', 'GET', `/requests/${id}`)).status, 200);
    assert.equal((await ctx.call('vee', 'GET', `/requests/${id}`)).status, 200, 'verifier while pending');
    await connect(ctx.call, 'ann', 'zed');
    assert.equal((await ctx.call('zed', 'GET', `/requests/${id}`)).status, 404, 'a mutual cannot see it before it is open');
  } finally { await ctx.close(); }
});
