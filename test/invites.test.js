'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { newToken, hashToken, monthStartIst, inviteState } = require('../src/invites');

const OWNER = 'owner@example.com';
const INVITE_ONLY = { error: 'Funds For Family is invite only. Ask someone who uses it to send you an invite.', code: 'invite_only' };
const tokenOf = (link) => link.split('#join=')[1];
const open = () => setup({ admitAll: false, ownerEmail: OWNER });
const tok = (t) => ({ 'x-invite-token': t });
const DAY = 864e5;

test('unit: tokens are 43-char base64url, hashed as SHA-256 hex', () => {
  const { token, tokenHash } = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(hashToken(token), tokenHash);
  assert.notEqual(newToken().token, token);
});

test('unit: monthStartIst is the 1st at 00:00 IST in UTC', () => {
  assert.equal(monthStartIst(new Date('2026-11-20T12:00:00Z')), '2026-10-31T18:30:00.000Z');
  // 2026-11-30T19:00Z is already 1 December in IST
  assert.equal(monthStartIst(new Date('2026-11-30T19:00:00Z')), '2026-11-30T18:30:00.000Z');
});

test('unit: inviteState', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const base = { expiresAt: new Date(now.getTime() + DAY).toISOString(), acceptedAt: null, revokedAt: null, supersededAt: null };
  assert.equal(inviteState(base, now), 'open');
  assert.equal(inviteState({ ...base, expiresAt: new Date(now.getTime() - 1).toISOString() }, now), 'expired');
  assert.equal(inviteState({ ...base, acceptedAt: 'x' }, now), 'accepted');
  assert.equal(inviteState({ ...base, revokedAt: 'x' }, now), 'revoked');
  assert.equal(inviteState({ ...base, supersededAt: 'x' }, now), 'superseded');
});

test('the owner signs in as admin and verifier; a stranger gets 403 invite_only', async () => {
  const s = await open();
  try {
    const o = await s.call('owner', 'GET', '/me');
    assert.equal(o.status, 200);
    assert.equal(o.body.user.isAdmin, true);
    assert.equal(o.body.user.isVerifier, true);
    const x = await s.call('stranger', 'GET', '/me');
    assert.equal(x.status, 403);
    assert.deepEqual(x.body, INVITE_ONLY);
    assert.equal(s.repo._state.users.size, 1, 'a refused stranger is not created');
  } finally { await s.close(); }
});

test('owner email match is case-insensitive', async () => {
  const s = await setup({ admitAll: false, ownerEmail: 'Owner@Example.com' });
  try {
    assert.equal((await s.call('owner', 'GET', '/me')).status, 200);
  } finally { await s.close(); }
});

test('an invite returns a link, a WhatsApp URL and the remaining allowance', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const r = await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.link, /\/app\/#join=[A-Za-z0-9_-]{43}$/);
    assert.ok(r.body.whatsappUrl.startsWith('https://wa.me/?text='));
    assert.equal(r.body.remainingThisMonth, 4);
    assert.equal(r.body.invite.email, 'kim@example.com');
    assert.ok(r.body.invite.id && r.body.invite.expiresAt);
    assert.equal(r.body.invite.tokenHash, undefined);
    assert.equal(s.sent[0].to, 'kim@example.com');
    assert.ok(s.sent[0].html.includes(r.body.link));
  } finally { await s.close(); }
});

test('an invited email signs in with no token and is connected both ways', async () => {
  const s = await open();
  try {
    const owner = (await s.call('owner', 'GET', '/me')).body.user;
    await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    const kim = await s.call('kim', 'GET', '/me');
    assert.equal(kim.status, 200);
    const c = await s.call('kim', 'GET', '/connections');
    assert.deepEqual(c.body.mutual.map((u) => u.id), [owner.id]);
    const list = await s.call('owner', 'GET', '/invites');
    assert.equal(list.body.invites[0].state, 'accepted');
  } finally { await s.close(); }
});

test('a token admits a person with a different email once; a second person gets 403', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const token = tokenOf((await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' })).body.link);
    const lee = await s.call('lee', 'GET', '/me', undefined, undefined, tok(token));
    assert.equal(lee.status, 200);
    const max = await s.call('max', 'GET', '/me', undefined, undefined, tok(token));
    assert.equal(max.status, 403);
    assert.deepEqual(max.body, INVITE_ONLY);
    // the intended email owner can no longer use the (accepted) invite either
    assert.equal((await s.call('kim', 'GET', '/me')).status, 403);
    // an existing member presenting a token changes nothing
    assert.equal((await s.call('lee', 'GET', '/me', undefined, undefined, tok(token))).status, 200);
    assert.equal(s.repo._state.users.size, 2);
  } finally { await s.close(); }
});

test('a wrong token is refused', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const r = await s.call('lee', 'GET', '/me', undefined, undefined, tok('A'.repeat(43)));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'invite_only');
  } finally { await s.close(); }
});

test('an expired token and an expired email invite are refused', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const token = tokenOf((await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' })).body.link);
    s.setNow(new Date(new Date('2026-11-20T12:00:00Z').getTime() + 15 * DAY));
    assert.equal((await s.call('lee', 'GET', '/me', undefined, undefined, tok(token))).status, 403);
    assert.equal((await s.call('kim', 'GET', '/me')).status, 403);
    const list = await s.call('owner', 'GET', '/invites');
    assert.equal(list.body.invites[0].state, 'expired');
  } finally { await s.close(); }
});

test('a revoked token is refused; only the inviter can revoke', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const made = (await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' })).body;
    // a different member cannot see or revoke it
    await s.call('owner', 'POST', '/invites', { email: 'pat@example.com' });
    await s.call('pat', 'GET', '/me');
    assert.equal((await s.call('pat', 'DELETE', `/invites/${made.invite.id}`)).status, 404);
    assert.equal((await s.call('owner', 'DELETE', `/invites/${made.invite.id}`)).status, 200);
    const token = tokenOf(made.link);
    assert.equal((await s.call('lee', 'GET', '/me', undefined, undefined, tok(token))).status, 403);
    assert.equal((await s.call('kim', 'GET', '/me')).status, 403);
    assert.equal((await s.call('owner', 'DELETE', '/invites/99999')).status, 404);
  } finally { await s.close(); }
});

test('the 6th invite in a month is 429; a revoked invite frees a slot', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      const r = await s.call('owner', 'POST', '/invites', { email: `p${i}@example.com` });
      assert.equal(r.status, 201);
      assert.equal(r.body.remainingThisMonth, 5 - i);
      ids.push(r.body.invite.id);
    }
    const over = await s.call('owner', 'POST', '/invites', { email: 'p6@example.com' });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'You have used all your invites this month');
    await s.call('owner', 'DELETE', `/invites/${ids[0]}`);
    assert.equal((await s.call('owner', 'POST', '/invites', { email: 'p6@example.com' })).status, 201);
  } finally { await s.close(); }
});

test('a per-member inviteLimit overrides the default', async () => {
  const s = await open();
  try {
    const owner = (await s.call('owner', 'GET', '/me')).body.user;
    s.repo._state.users.get(owner.id).inviteLimit = 1;
    assert.equal((await s.call('owner', 'POST', '/invites', { email: 'a@example.com' })).status, 201);
    assert.equal((await s.call('owner', 'POST', '/invites', { email: 'b@example.com' })).status, 429);
  } finally { await s.close(); }
});

test('inviting your own email or an existing member is 409', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    await s.call('kim', 'GET', '/me');
    for (const email of [OWNER, 'Owner@Example.com', 'kim@example.com', 'KIM@example.com']) {
      const r = await s.call('owner', 'POST', '/invites', { email });
      assert.equal(r.status, 409, email);
      assert.equal(r.body.error, 'This person is already a member');
    }
    assert.equal((await s.call('owner', 'POST', '/invites', { email: 'nope' })).status, 400);
  } finally { await s.close(); }
});

test('two members invite the same person; joining with one supersedes the other', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    for (const n of ['amy', 'bob']) await s.call('owner', 'POST', '/invites', { email: `${n}@example.com` });
    const amy = (await s.call('amy', 'GET', '/me')).body.user;
    const bob = (await s.call('bob', 'GET', '/me')).body.user;
    const a = (await s.call('amy', 'POST', '/invites', { email: 'zed@example.com' })).body;
    const b = (await s.call('bob', 'POST', '/invites', { email: 'zed@example.com' })).body;
    const zed = await s.call('zed', 'GET', '/me', undefined, undefined, tok(tokenOf(a.link)));
    assert.equal(zed.status, 200);
    assert.equal((await s.call('bob', 'GET', '/invites')).body.invites.find((i) => i.id === b.invite.id).state, 'superseded');
    assert.equal((await s.call('amy', 'GET', '/invites')).body.invites.find((i) => i.id === a.invite.id).state, 'accepted');
    const mutual = (await s.call('zed', 'GET', '/connections')).body.mutual.map((u) => u.id);
    assert.deepEqual(mutual, [amy.id]);
    assert.ok(!mutual.includes(bob.id));
    // B's token is dead
    assert.equal((await s.call('late', 'GET', '/me', undefined, undefined, tok(tokenOf(b.link)))).status, 403);
  } finally { await s.close(); }
});

test('the database stores no raw token', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    const { link } = (await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' })).body;
    const token = tokenOf(link);
    const rows = [...s.repo._state.invites.values()];
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.equal(rows[0].tokenHash, hashToken(token));
    assert.ok(!JSON.stringify((await s.call('owner', 'GET', '/invites')).body).includes(token));
    assert.ok(!JSON.stringify(s.logged).includes(token));
  } finally { await s.close(); }
});

test('concurrent first sign-in: a duplicate clerk_id on create reuses the row the other request made', async () => {
  const s = await setup({ admitAll: true });
  try {
    const realCreate = s.repo.createUser.bind(s.repo);
    let calls = 0;
    s.repo.createUser = async (row) => {
      calls += 1;
      await realCreate(row); // the "other request" wins the race
      throw new Error('duplicate key value violates unique constraint "users_clerk_id_key"');
    };
    const r = await s.call('ann', 'GET', '/me');
    assert.equal(r.status, 200, r.text);
    assert.equal(calls, 1);
    assert.equal(r.body.user.name, 'ann');
    assert.equal(s.repo._state.users.size, 1);
  } finally { await s.close(); }
});

test('a create failure with no row to re-read is a 500, not an admission', async () => {
  const s = await setup({ admitAll: true });
  try {
    s.repo.createUser = async () => { throw new Error('db down'); };
    const r = await s.call('ann', 'GET', '/me');
    assert.equal(r.status, 500);
  } finally { await s.close(); }
});

test('admission side effects never run for existing members', async () => {
  const s = await open();
  try {
    await s.call('owner', 'GET', '/me');
    await s.call('owner', 'POST', '/invites', { email: 'kim@example.com' });
    await s.call('kim', 'GET', '/me');
    const open2 = (await s.call('owner', 'POST', '/invites', { email: 'kim2@example.com' })).body;
    // kim (existing) presents someone else's open token: the invite must stay open
    await s.call('kim', 'GET', '/me', undefined, undefined, tok(tokenOf(open2.link)));
    assert.equal((await s.call('owner', 'GET', '/invites')).body.invites.find((i) => i.id === open2.invite.id).state, 'open');
  } finally { await s.close(); }
});
