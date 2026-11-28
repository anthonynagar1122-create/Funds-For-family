'use strict';
// Production-readiness journeys: owner/admin, invited newcomer, deleted member, signed-out visitor.
// API-level (memory repo, fixed clock) plus a few file-level checks on public/ and config files.
// Each journey has one end-to-end test that passes today for what WORKS. Every gap is a `todo` test
// carrying the real assertions the fixed behaviour must meet (see docs/production-readiness/03-owner-newcomer-deleted.md).
// A todo test that currently fails does not fail the run; when the gap is fixed it starts to pass and the
// `todo` marker should be removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('../helpers/harness');
const { startRequest, lend, idOf, connect, requestBody } = require('../helpers/lifecycle');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const OWNER = 'owner@example.com';
const DAY = 864e5;
const tokenOf = (link) => link.split('#join=')[1];
const withToken = (t) => ({ 'x-invite-token': t });
const INVITE_ONLY_CODE = 'invite_only';
const gap = (name, reason, fn) => test(name, { todo: `gap: ${reason}` }, fn);

// A closed world: nobody joins without an invite, the owner is the only way in.
const closed = (extra = {}) => setup({ admitAll: false, ownerEmail: OWNER, ...extra });

/** `inviter` invites `name` by email and `name` signs in with the link's token. Returns ids and the one-time token. */
async function join(s, inviter, name, { email, signInEmail } = {}) {
  const inviteEmail = email ?? `${name}@example.com`;
  const inv = await s.call(inviter, 'POST', '/invites', { email: inviteEmail });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = tokenOf(inv.body.link);
  const headers = { ...withToken(token), ...(signInEmail ? { 'x-test-email': signInEmail } : {}) };
  const me = await s.call(name, 'GET', '/me', undefined, undefined, headers);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  return { id: me.body.user.id, token, invite: inv.body, me: me.body.user };
}

/** Owner plus borrower, contact, second verifier and lender, all admitted by invite. Owner and second verifier can verify. */
async function pilot(s) {
  await s.call('owner', 'GET', '/me');
  const ownerId = await idOf(s.call, 'owner');
  assert.equal((await s.call('owner', 'POST', `/admin/members/${ownerId}/invite-limit`, { limit: 20 })).status, 200);
  const ids = { owner: ownerId };
  for (const name of ['asha', 'ravi', 'dave', 'meera']) ids[name] = (await join(s, 'owner', name)).id;
  assert.equal((await s.call('owner', 'POST', `/admin/members/${ids.dave}/verifier`, { on: true })).status, 200);
  await connect(s.call, 'asha', 'meera');
  return ids;
}

async function approve(s, id) {
  for (const who of ['owner', 'dave']) {
    const r = await s.call(who, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

/** asha asks, ravi is the trusted contact, owner and dave approve. Returns the request id (open). */
async function openRequest(s) {
  const id = await startRequest(s.call, 'asha', 'ravi');
  await approve(s, id);
  return id;
}

// ---------------------------------------------------------------- Journey 1: owner / admin

test('journey owner: first sign-in via OWNER_EMAIL, invite members on WhatsApp, monitor, settle a stuck entry', async () => {
  const s = await closed();
  try {
    // First sign-in: admin and verifier, no invite needed.
    const first = await s.call('owner', 'GET', '/me');
    assert.equal(first.status, 200);
    assert.equal(first.body.user.isAdmin, true);
    assert.equal(first.body.user.isVerifier, true);
    // A non-member is turned away and never created.
    const stranger = await s.call('stranger', 'GET', '/me');
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.code, INVITE_ONLY_CODE);
    // A plain member cannot see any admin route.
    const ids = await pilot(s);
    for (const p of ['/admin/members', '/admin/invites', '/admin/stats', '/admin/help-messages', '/admin/stuck', '/admin/verification-gaps']) {
      assert.equal((await s.call('asha', 'GET', p)).status, 403, p);
    }
    // Invite via WhatsApp: link plus a wa.me deep link that carries it; the invitee also gets the email copy.
    const inv = await s.call('owner', 'POST', '/invites', { email: 'kiran@example.com' });
    assert.equal(inv.status, 201);
    assert.match(inv.body.whatsappUrl, /^https:\/\/wa\.me\/\?text=/);
    assert.ok(decodeURIComponent(inv.body.whatsappUrl).includes(inv.body.link));
    assert.ok(s.sent.some((m) => m.to === 'kiran@example.com' && m.html.includes(inv.body.link)), 'invite email to the invitee');
    // Admin page data: members, invites (open), stats.
    const members = (await s.call('owner', 'GET', '/admin/members')).body.members;
    assert.deepEqual(members.map((m) => m.name).sort(), ['asha', 'dave', 'meera', 'owner', 'ravi']);
    assert.equal(members.find((m) => m.name === 'dave').isVerifier, true);
    const invitesList = (await s.call('owner', 'GET', '/admin/invites')).body.invites;
    assert.equal(invitesList.find((i) => i.email === 'kiran@example.com').state, 'open');
    assert.equal((await s.call('owner', 'DELETE', `/admin/invites/${inv.body.invite.id}`)).body.invite.state, 'revoked');
    assert.equal((await s.call('owner', 'GET', '/admin/stats')).body.invitesAccepted, 4);
    // The owner cannot remove their own verifier flag.
    assert.equal((await s.call('owner', 'POST', `/admin/members/${ids.owner}/verifier`, { on: false })).status, 409);
    // Invite limit validation.
    assert.equal((await s.call('owner', 'POST', `/admin/members/${ids.asha}/invite-limit`, { limit: 51 })).status, 400);
    assert.equal((await s.call('owner', 'POST', `/admin/members/${ids.asha}/invite-limit`, { limit: 0 })).status, 200);
    assert.equal((await s.call('asha', 'POST', '/invites', { email: 'x@example.com' })).status, 429);
    // Help message: member writes, owner sees it with the sender's email, resolves it.
    assert.equal((await s.call('asha', 'POST', '/help', { body: 'I cannot find my request' })).status, 201);
    const help = (await s.call('owner', 'GET', '/admin/help-messages')).body.messages;
    assert.equal(help[0].email, 'asha@example.com');
    assert.equal((await s.call('owner', 'POST', `/admin/help-messages/${help[0].id}/resolve`)).status, 200);
    // Verification gap: with only the owner as verifier a new request cannot reach two approvals.
    await s.call('owner', 'POST', `/admin/members/${ids.dave}/verifier`, { on: false });
    const stuckReq = await startRequest(s.call, 'asha', 'ravi');
    const gaps = (await s.call('owner', 'GET', '/admin/verification-gaps')).body.requests;
    assert.deepEqual(gaps.map((g) => [g.requestId, g.eligibleVerifiers, g.needed]), [[stuckReq, 1, 2]]);
    await s.call('owner', 'POST', `/admin/members/${ids.dave}/verifier`, { on: true });
    assert.deepEqual((await s.call('owner', 'GET', '/admin/verification-gaps')).body.requests, []);
    // Stuck entry: meera says she sent the money; nobody answers for 8 days; the owner settles with a note.
    await approve(s, stuckReq);
    const c = await lend(s.call, 'meera', 'asha', stuckReq, 500, { confirm: false });
    assert.deepEqual((await s.call('owner', 'GET', '/admin/stuck')).body.entries, []);
    s.setNow(new Date(Date.parse('2026-11-20T12:00:00Z') + 8 * DAY));
    const stuck = (await s.call('owner', 'GET', '/admin/stuck')).body.entries;
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].payerName, 'meera');
    assert.equal(stuck[0].daysWaiting, 8);
    assert.equal((await s.call('owner', 'POST', `/admin/contributions/${c}/settle`, { action: 'confirm', note: 'x' })).status, 400, 'note required');
    const settled = await s.call('owner', 'POST', `/admin/contributions/${c}/settle`, { action: 'confirm', note: 'Checked with both on the phone' });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.request.status, 'funded');
  } finally { await s.close(); }
});

gap('owner: a help message emails the owner (P-42)', 'P-42 says the owner gets an email for every help message; nothing is sent', async () => {
  const s = await closed();
  try {
    await pilot(s);
    s.sent.length = 0;
    assert.equal((await s.call('asha', 'POST', '/help', { body: 'Please help me with my request' })).status, 201);
    assert.ok(s.sent.some((m) => m.to === OWNER), 'no email reached OWNER_EMAIL');
  } finally { await s.close(); }
});

gap('owner: settling a stuck entry emails both sides (spec 5.5a)', 'spec 5.5a: both sides get an email when the owner settles; admin routes send none', async () => {
  const s = await closed();
  try {
    await pilot(s);
    const id = await openRequest(s);
    const c = await lend(s.call, 'meera', 'asha', id, 500, { confirm: false });
    s.setNow(new Date(Date.parse('2026-11-20T12:00:00Z') + 8 * DAY));
    s.sent.length = 0;
    assert.equal((await s.call('owner', 'POST', `/admin/contributions/${c}/settle`, { action: 'remove', note: 'Lender cannot be reached' })).status, 200);
    const to = s.sent.map((m) => m.to);
    assert.ok(to.includes('asha@example.com') && to.includes('meera@example.com'), `emails sent to: ${to.join(',') || 'nobody'}`);
  } finally { await s.close(); }
});

gap('owner: admin actions leave an audit log the owner can read', 'only settle rows carry settled_by; verifier toggles, invite revokes and limit changes are unrecorded', async () => {
  const s = await closed();
  try {
    const ids = await pilot(s);
    await s.call('owner', 'POST', `/admin/members/${ids.asha}/verifier`, { on: true });
    const log = await s.call('owner', 'GET', '/admin/audit-log');
    assert.equal(log.status, 200);
    assert.ok(log.body.entries.some((e) => /verifier/i.test(e.action) && e.actorId === ids.owner && e.targetId === ids.asha));
  } finally { await s.close(); }
});

gap('owner: the owner can export the ledger and members (CSV/JSON)', 'no export route exists; the only copy of the data is Supabase itself', async () => {
  const s = await closed();
  try {
    await pilot(s);
    const r = await s.call('owner', 'GET', '/admin/export');
    assert.equal(r.status, 200);
    assert.ok(r.text.length > 0);
  } finally { await s.close(); }
});

gap('owner: the owner can suspend a member who must be locked out', 'no suspend or remove-member route; the only lever is deleting rows in Supabase', async () => {
  const s = await closed();
  try {
    const ids = await pilot(s);
    const r = await s.call('owner', 'POST', `/admin/members/${ids.asha}/suspend`, { on: true });
    assert.equal(r.status, 200);
    assert.equal((await s.call('asha', 'GET', '/me')).status, 403);
  } finally { await s.close(); }
});

gap('owner: the only admin cannot delete their own account', 'DELETE /me has no last-admin guard; the owner could orphan the admin page', async () => {
  const s = await closed();
  try {
    await pilot(s);
    const r = await s.call('owner', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 409, `got ${r.status}`);
  } finally { await s.close(); }
});

gap('owner: a requested verification gap is visible to the borrower (spec 5.7a)', 'borrower only sees "Awaiting verification"; "Waiting for the verification team" copy does not exist', async () => {
  const copy = ['public/app/pages/request.js', 'public/app/pages/home.js', 'public/app.js'].map((f) => read(f)).join('\n');
  assert.match(copy, /Waiting for the verification team/);
});

gap('owner: daily cron is wired in vercel.json and guarded by CRON_SECRET (Phase C)', 'no cron route, no vercel crons entry, no CRON_SECRET handling anywhere in src/', async () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(Array.isArray(vercel.crons) && vercel.crons.some((c) => /cron\/daily/.test(c.path)), 'vercel.json has no crons');
  assert.match(read('src', 'app.js') + read('src', 'services.js'), /CRON_SECRET/);
});

test('owner: email sending is behind EMAIL_ENABLED, default off (Phase C)', async () => {
  assert.match(read('src', 'services.js') + read('src', 'config.js') + read('src', 'mailer.js'), /EMAIL_ENABLED/);
});

gap('owner: reminder, overdue and thank-you emails exist (Phase C)', 'only transactional emails exist; no 7-day/1-day/overdue reminders, date-change or thank-you mail', async () => {
  const src = ['app.js', 'services.js', 'supabase-repo.js', 'memory-repo.js'].map((f) => read('src', f)).join('\n');
  assert.match(src, /notifications_sent|notificationsSent/, 'the reminder dedupe table is unused by any code in src/');
});

test('owner: .env.example documents the pilot variables and drops the removed interest rate', async () => {
  const env = read('.env.example');
  assert.match(env, /^OWNER_EMAIL=/m);
  assert.match(env, /^#?\s*CRON_SECRET=/m);
  assert.match(env, /^#?\s*EMAIL_ENABLED=/m);
  assert.doesNotMatch(env, /INTEREST_RATE_ANNUAL/);
});

// ---------------------------------------------------------------- Journey 2: invited newcomer

test('journey newcomer: link, admission rules, welcome, connected to the inviter, first request', async () => {
  const s = await closed();
  try {
    await s.call('owner', 'GET', '/me');
    // Not invited: the exact invite-only answer, and no member row is created.
    const before = s.repo._state.users.size;
    const cold = await s.call('priya', 'GET', '/me');
    assert.equal(cold.status, 403);
    assert.equal(cold.body.code, INVITE_ONLY_CODE);
    assert.equal(s.repo._state.users.size, before);

    // WhatsApp link -> sign in with that token.
    const inv = await s.call('owner', 'POST', '/invites', { email: 'priya@example.com' });
    const token = tokenOf(inv.body.link);
    // Unverified email: refused with its own code and the invite stays usable.
    const unverified = await s.call('priya', 'GET', '/me', undefined, undefined, { ...withToken(token), 'x-test-no-email': '1' });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.code, 'email_unverified');
    assert.equal((await s.call('owner', 'GET', '/invites')).body.invites[0].state, 'open');
    // Verified: admitted, name from the sign-in, and the inviter is shown.
    const me = await s.call('priya', 'GET', '/me', undefined, undefined, withToken(token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.inviterName, 'owner');
    assert.equal(me.body.user.welcomedAt, null);
    assert.equal(me.body.user.termsAcceptedAt, null);
    assert.equal(me.body.user.isAdmin, false);
    // Connected to the inviter both ways at once.
    const conn = (await s.call('priya', 'GET', '/connections')).body;
    assert.deepEqual(conn.mutual.map((u) => u.name), ['owner']);
    // The token is single use: someone else with the same link is refused.
    const reuse = await s.call('mallory', 'GET', '/me', undefined, undefined, withToken(token));
    assert.equal(reuse.status, 403);
    // Revoked, expired.
    const rev = await s.call('owner', 'POST', '/invites', { email: 'rev@example.com' });
    await s.call('owner', 'DELETE', `/invites/${rev.body.invite.id}`);
    assert.equal((await s.call('rev', 'GET', '/me', undefined, undefined, withToken(tokenOf(rev.body.link)))).status, 403);
    const exp = await s.call('owner', 'POST', '/invites', { email: 'exp@example.com' });
    s.setNow(new Date(Date.parse('2026-11-20T12:00:00Z') + 15 * DAY));
    assert.equal((await s.call('exp', 'GET', '/me', undefined, undefined, withToken(tokenOf(exp.body.link)))).status, 403);
    s.setNow(new Date(Date.parse('2026-11-20T12:00:00Z')));
    // Welcome: name, UPI, terms, finish. Idempotent.
    const patched = await s.call('priya', 'PATCH', '/me', { name: 'Priya Sharma', upiId: 'priya@okbank' });
    assert.equal(patched.body.user.upiId, 'priya@okbank');
    assert.equal((await s.call('priya', 'PATCH', '/me', { upiId: 'not a upi' })).status, 400);
    const accepted = await s.call('priya', 'POST', '/me/accept-terms');
    assert.ok(accepted.body.user.termsAcceptedAt);
    assert.equal((await s.call('priya', 'POST', '/me/accept-terms')).body.user.termsAcceptedAt, accepted.body.user.termsAcceptedAt);
    assert.ok((await s.call('priya', 'POST', '/me/welcomed')).body.user.welcomedAt);
    // First request: the inviter is already a mutual connection, so can be the trusted contact.
    const ownerId = await idOf(s.call, 'owner');
    const created = await s.call('priya', 'POST', '/requests', requestBody(ownerId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.request.status, 'awaiting_contact');
    assert.ok(s.sent.some((m) => m.to === 'owner@example.com' && /trusted contact/.test(m.subject)), 'trusted contact is emailed');
  } finally { await s.close(); }
});

test('journey newcomer: email-matched invite works without the link, a forwarded link shows as a mismatch to the owner', async () => {
  const s = await closed();
  try {
    await s.call('owner', 'GET', '/me');
    await s.call('owner', 'POST', '/invites', { email: 'Neha@Example.com' });
    // No token at all: the invite for the verified email is enough (case-insensitive).
    assert.equal((await s.call('neha', 'GET', '/me')).status, 200);
    // Forwarded link: someone else signs in with another address (P-35).
    const j = await join(s, 'owner', 'tarun', { email: 'tarun@example.com', signInEmail: 'tarun.work@example.com' });
    assert.equal(j.me.email, 'tarun.work@example.com');
    const row = (await s.call('owner', 'GET', '/admin/invites')).body.invites.find((i) => i.email === 'tarun@example.com');
    assert.equal(row.state, 'accepted');
    assert.equal(row.joinedEmail, 'tarun.work@example.com');
    assert.notEqual(row.joinedEmail, row.email);
  } finally { await s.close(); }
});

gap('newcomer: an expired, revoked or used link says so instead of the generic invite-only message', 'all dead links return the same invite_only error, so a 15-day-old WhatsApp link looks like "you are not allowed"', async () => {
  const s = await closed();
  try {
    await s.call('owner', 'GET', '/me');
    const exp = await s.call('owner', 'POST', '/invites', { email: 'late@example.com' });
    s.setNow(new Date(Date.parse('2026-11-20T12:00:00Z') + 15 * DAY));
    const r = await s.call('late', 'GET', '/me', undefined, undefined, withToken(tokenOf(exp.body.link)));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'invite_expired');
  } finally { await s.close(); }
});

gap('newcomer: the server requires accepted terms before a member can act (P-36)', 'terms and welcome are enforced only by app.js; any API call works without ever accepting', async () => {
  const s = await closed();
  try {
    await s.call('owner', 'GET', '/me');
    const j = await join(s, 'owner', 'newbie');
    assert.equal(j.me.termsAcceptedAt, null);
    const ownerId = await idOf(s.call, 'owner');
    const r = await s.call('newbie', 'POST', '/requests', requestBody(ownerId));
    assert.equal(r.status, 403, `a member who never accepted the terms created a request (status ${r.status})`);
  } finally { await s.close(); }
});

gap('newcomer: the not-invited screen links back to the landing page and offers sign-out (spec 8.11)', '#view-not-invited has one sentence and no link, no sign-out, no "ask for a new link"', async () => {
  const html = read('public', 'app', 'index.html');
  const block = html.slice(html.indexOf('id="view-not-invited"'), html.indexOf('id="view-activity"'));
  assert.match(block, /href="\/"/, 'no link to the landing page');
  assert.match(block, /sign out|different account/i);
});

gap('newcomer: the signed-out /app screen acknowledges an invite link', 'a person arriving from WhatsApp sees generic "Sign in to continue" and cannot tell the invite was picked up', async () => {
  const js = read('public', 'app.js');
  const html = read('public', 'app', 'index.html');
  assert.match(js + html, /You've been invited|You have been invited|invited you/i);
});

gap('newcomer: the unverified-email refusal is explained on screen', 'app.js handles code invite_only only; email_unverified falls through to a 3.5 second toast', async () => {
  assert.match(read('public', 'app.js'), /email_unverified/);
});

gap('newcomer: a newcomer can invite a second person from the welcome step', 'welcome step 2 only says "invite one more person"; there is no form or link to Circle', async () => {
  assert.match(read('public', 'app', 'pages', 'welcome.js'), /href="#\/circle"|#\/circle/);
});

// ---------------------------------------------------------------- Journey 3: deleted member

test('journey deleted: blocked by obligations, then deleted, anonymised, locked out, Clerk login removed', async () => {
  const clerkDeleted = [];
  const s = await closed({ deleteClerkUser: async (id) => { clerkDeleted.push(id); } });
  try {
    const ids = await pilot(s);
    const reqId = await openRequest(s);
    await lend(s.call, 'meera', 'asha', reqId, 500);
    const del = (who) => s.call(who, 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal((await s.call('asha', 'DELETE', '/me', {})).status, 400, 'typed confirmation required');
    // Blocked: active request, trusted contact on an active request, money owed to the lender.
    const a = await del('asha'); assert.equal(a.status, 409); assert.match(a.body.error, /still active/);
    const r = await del('ravi'); assert.equal(r.status, 409); assert.match(r.body.error, /trusted contact/);
    const m = await del('meera'); assert.equal(m.status, 409); assert.match(m.body.error, /owed money/);
    assert.deepEqual(clerkDeleted, []);
    // Repay in full and confirm: request is repaid and nobody is blocked any more.
    const rep = await s.call('asha', 'POST', `/requests/${reqId}/repayments`, { lenderId: ids.meera, amount: 500 });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    assert.equal((await del('meera')).status, 409, 'an unconfirmed repayment still blocks the lender');
    assert.equal((await s.call('meera', 'POST', `/repayments/${rep.body.repayment.id}/confirm`)).status, 200);
    assert.equal((await s.call('asha', 'GET', `/requests/${reqId}`)).body.request.status, 'repaid');
    // A help message with personal text before leaving (used by the gap test below too).
    assert.equal((await s.call('asha', 'POST', '/help', { body: 'My phone number is 98xxxxxx10, call me' })).status, 201);

    const ok = await del('asha');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(clerkDeleted, ['clerk_asha']);

    // Anonymised for everyone else; no email or UPI leaks.
    const seen = (await s.call('meera', 'GET', `/users/${ids.asha}`)).body.user;
    assert.equal(seen.name, 'Former member');
    assert.equal(seen.email, undefined);
    assert.equal(seen.upiId, undefined);
    assert.equal(s.repo._state.users.get(ids.asha).email, `deleted-${ids.asha}@deleted.invalid`);
    // Connections and search drop her; admin member list drops her.
    assert.ok(!(await s.call('meera', 'GET', '/connections')).body.mutual.some((u) => u.id === ids.asha));
    assert.deepEqual((await s.call('meera', 'GET', '/users?q=asha')).body.users, []);
    assert.ok(!(await s.call('owner', 'GET', '/admin/members')).body.members.some((x) => x.id === ids.asha));
    // The ledger is intact for the lender: the request and her confirmed money are still there.
    const detail = (await s.call('meera', 'GET', `/requests/${reqId}`)).body.request;
    assert.equal(detail.status, 'repaid');
    assert.equal(detail.raisedCents, 50000);
    assert.equal((await s.call('meera', 'GET', '/activity')).body.lending.length, 1);
    // Cannot sign back in: the old sign-in finds no member and, with no invite, is refused.
    const back = await s.call('asha', 'GET', '/me');
    assert.equal(back.status, 403);
    assert.equal(back.body.code, INVITE_ONLY_CODE);
    // Her own old pending invite and follows are gone; the same email can be invited again as a new member.
    const again = await s.call('owner', 'POST', '/invites', { email: 'asha@example.com' });
    assert.equal(again.status, 201, 'the freed email can be invited again');
  } finally { await s.close(); }
});

test('journey deleted: a Clerk failure does not undo the deletion and nothing sensitive is logged', async () => {
  const s = await closed({ deleteClerkUser: async () => { throw new Error('clerk is down for clerk_asha'); } });
  try {
    const ids = await pilot(s);
    const r = await s.call('asha', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 200);
    assert.ok(s.repo._state.users.get(ids.asha).deletedAt);
    assert.equal((await s.call('asha', 'GET', '/me')).status, 403, 'the app still refuses her even though Clerk kept the login');
    assert.ok(s.logged.length >= 1, 'the failure is logged');
  } finally { await s.close(); }
});

gap('deleted: the response says when the sign-in account could not be removed', 'a failed Clerk delete is only logged, so the member is told "deleted" while their email stays in Clerk and nobody retries', async () => {
  const s = await closed({ deleteClerkUser: async () => { throw new Error('clerk is down'); } });
  try {
    await pilot(s);
    const r = await s.call('asha', 'DELETE', '/me', { confirm: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(r.body.clerkRemoved, false);
  } finally { await s.close(); }
});

gap('deleted: free-text help messages are removed or redacted with the account (P-36)', 'deleteAccount anonymises users and invites only; help_messages.body (often a phone number) stays', async () => {
  const s = await closed();
  try {
    await pilot(s);
    await s.call('asha', 'POST', '/help', { body: 'My phone number is 98xxxxxx10, call me' });
    assert.equal((await s.call('asha', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    const left = (await s.call('owner', 'GET', '/admin/help-messages')).body.messages;
    assert.ok(!left.some((m) => /98xxxxxx10/.test(m.body)), 'personal text survived deletion');
  } finally { await s.close(); }
});

gap('deleted: the person is told by email that the account was deleted (P-40 account events)', 'P-40 lists account events as essential email; DELETE /me sends nothing', async () => {
  const s = await closed();
  try {
    await pilot(s);
    s.sent.length = 0;
    assert.equal((await s.call('asha', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    assert.ok(s.sent.some((m) => m.to === 'asha@example.com' && /deleted/i.test(m.subject)), 'no confirmation email');
  } finally { await s.close(); }
});

test('journey deleted: a verifier who deletes leaves the owner a visible verification gap', async () => {
  const s = await closed();
  try {
    await pilot(s);
    const waiting = await startRequest(s.call, 'asha', 'ravi');
    assert.deepEqual((await s.call('owner', 'GET', '/admin/verification-gaps')).body.requests, []);
    // dave is one of only two eligible verifiers. After he deletes his account the owner sees the gap.
    assert.equal((await s.call('dave', 'DELETE', '/me', { confirm: 'DELETE' })).status, 200);
    const gaps = (await s.call('owner', 'GET', '/admin/verification-gaps')).body.requests;
    assert.deepEqual(gaps.map((g) => [g.requestId, g.eligibleVerifiers]), [[waiting, 1]]);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- Journey 4: signed-out visitor

const landing = read('public', 'index.html');
const landingText = landing.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');

test('journey visitor: landing claims match the product, SEO and install basics are in place', () => {
  // Claims that the product backs up.
  assert.match(landingText, /₹50,000/);
  assert.match(landingText, /12 months/);
  assert.match(landingText, /no interest/i);
  assert.match(landingText, /does not move money/i);
  assert.match(landingText, /trusted contact/i);
  assert.match(landingText, /invite only/i);
  assert.doesNotMatch(landingText, /\$\s?\d|nominee|guarantor|\d+%\s*a year/i);
  // SEO.
  assert.match(landing, /<title>[^<]{20,}<\/title>/);
  assert.match(landing, /<meta name="description" content="[^"]{60,}"/);
  assert.match(landing, /<link rel="canonical" href="https:\/\/funds-for-family\.vercel\.app\/">/);
  assert.match(landing, /property="og:image" content="https:\/\/funds-for-family\.vercel\.app\/og-image\.png"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'og-image.png')));
  const ld = landing.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(JSON.parse(ld[1])['@graph'].length >= 2, 'valid JSON-LD');
  const robots = read('public', 'robots.txt');
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/app\//);
  assert.match(read('public', 'sitemap.xml'), /<loc>https:\/\/funds-for-family\.vercel\.app\/<\/loc>/);
  // The member app is not indexed; the landing page is.
  assert.match(read('public', 'app', 'index.html'), /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(landing, /noindex/);
  // Sign-in entry points reach the app.
  assert.match(landing, /<a class="btn btn-secondary btn-sm" href="\/app\/">Sign in<\/a>/);
  // Install: manifest is valid and its icons exist; the app registers the service worker.
  const manifest = JSON.parse(read('public', 'manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/app/');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, 'public', icon.src)), icon.src);
  assert.match(read('public', 'app', 'index.html'), /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(read('public', 'app', 'index.html'), /serviceWorker\.register\('\/sw\.js'/);
  // Terms and privacy text exists inside the app and is marked as a draft for lawyer review.
  const legal = read('public', 'app', 'pages', 'legal.js');
  assert.match(legal, /Terms of use/);
  assert.match(legal, /Privacy notice/);
  assert.match(legal, /not yet been reviewed by a lawyer/);
});

test('visitor: the landing footer links to Terms and Privacy (spec 8.10)', async () => {
  const footer = landing.slice(landing.indexOf('<footer'));
  assert.match(footer, /href="[^"]*(terms)[^"]*"/i);
  assert.match(footer, /href="[^"]*(privacy)[^"]*"/i);
});

test('visitor: /terms and /privacy are real static pages (spec 8.10)', async () => {
  const vercel = read('vercel.json');
  const has = (n) => fs.existsSync(path.join(ROOT, 'public', `${n}.html`)) || fs.existsSync(path.join(ROOT, 'public', n, 'index.html')) || new RegExp(`"source":\\s*"/${n}"`).test(vercel);
  assert.ok(has('terms') && has('privacy'));
});

gap('visitor: the hero explains that joining is by invitation next to the call to action (spec 8 landing additions)', 'hero says "Start a request" with no invite-only line; a stranger who taps it hits the Not invited dead end', async () => {
  const hero = landing.slice(landing.indexOf('<section class="hero"'), landing.indexOf('<!-- 2. Trust strip -->'));
  assert.match(hero, /invite/i);
});

gap('visitor: the FAQ explains adding the app to the home screen (spec 8 landing additions, P-31)', 'no "home screen" copy on the landing page, no install hint in the app', async () => {
  assert.match(landingText, /home screen/i);
});

test('visitor: landing promises only what exists: trusted-contact reminders need the Phase C cron', async () => {
  const promises = /due-date reminders|kept informed of the due date/i.test(landingText);
  const cron = /"crons"/.test(read('vercel.json'));
  assert.ok(!promises || cron, 'landing promises reminders but vercel.json has no crons');
});

gap('visitor: the landing page has a favicon', 'no <link rel="icon"> on landing or app; browsers request /favicon.ico and get a 404', async () => {
  assert.match(landing, /<link rel="icon"/);
});

// Closed by the P-45 merge: the security branch rewrote the README (interest disabled, no nominee wording).
test('visitor: the README no longer describes interest and nominees', async () => {
  assert.doesNotMatch(read('README.md'), /interest starts|nominee/i);
});
