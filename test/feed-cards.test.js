'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');


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
    await s.call('ben', 'POST', '/follows', { userId: ann.id });
    const id = (await s.call('ann', 'POST', '/requests', { amount: 500, purpose: 'School fees for the second term at the college', repaymentDate: '2027-02-01', category: 'education', trustedContactId: nat.id })).body.request.id;
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('zed', 'GET', '/me');
    await s.call('zed', 'POST', `/requests/${id}/contributions`, { amount: 120 });
    const feed = await s.call('ben', 'GET', '/feed');
    assert.equal(feed.status, 200);
    assert.equal(feed.body.requests[0].raisedCents, 12000);
  } finally { await s.close(); }
});
