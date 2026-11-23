'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { startRequest, connect, lend } = require('./helpers/lifecycle');


test('feed cards carry the amount raised so far', async () => {
  const s = await setup();
  try {
    const ann = (await s.call('ann', 'GET', '/me')).body.user;
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const vee = (await s.call('vee', 'GET', '/me')).body.user;
    const wes = (await s.call('wes', 'GET', '/me')).body.user;
    await s.repo.setVerifier(vee.id, true);
    await s.repo.setVerifier(wes.id, true);
    await s.call('ben', 'GET', '/me');
    await connect(s.call, 'ann', 'ben');
    const id = await startRequest(s.call, 'ann', 'nat');
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('zed', 'GET', '/me');
    await connect(s.call, 'ann', 'zed');
    await lend(s.call, 'zed', 'ann', id, 120);
    const feed = await s.call('ben', 'GET', '/feed');
    assert.equal(feed.status, 200);
    assert.equal(feed.body.requests[0].raisedCents, 12000);
  } finally { await s.close(); }
});
