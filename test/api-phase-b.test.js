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
