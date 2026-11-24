'use strict';
// Circle privacy, shareable invites and connection suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

const NOW = new Date('2026-11-20T12:00:00Z');

async function setup() {
  const repo = createMemoryRepo();
  const app = createApp({
    repo, now: () => NOW, mailer: async () => {}, logger: { error() {} }, appUrl: 'https://ff.test',
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const me = async (name) => (await call(name, 'GET', '/me')).body.user;
  const follow = (who, id) => call(who, 'POST', '/follows', { userId: id });
  const close = () => { server.closeAllConnections(); return new Promise((res) => server.close(res)); };
  return { repo, call, me, follow, close };
}

const req = (nomineeId) => ({ amount: 500, purpose: 'School fees for the second term at the local college', repaymentDate: '2027-02-01', nomineeId, phone: '+1 555 010 0100' });

// Ann borrows, Nat is nominee. Vee and Wes verify, which opens the request for funding.
async function openRequest(s) {
  const ann = await s.me('ann'); const nat = await s.me('nat'); const vee = await s.me('vee'); const wes = await s.me('wes');
  await s.repo.setVerifier(vee.id, true); await s.repo.setVerifier(wes.id, true);
  const id = (await s.call('ann', 'POST', '/requests', req(nat.id))).body.request.id;
  return { ann, nat, vee, wes, id };
}

// ---- Circle privacy ----

test('circle: a stranger cannot see or fund a request (404, so its existence does not leak)', async () => {
  const s = await setup();
  try {
    const { id } = await openRequest(s);
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.me('zed');
    assert.equal((await s.call('zed', 'GET', `/requests/${id}`)).status, 404);
    assert.equal((await s.call('zed', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 10 })).status, 404);
  } finally { await s.close(); }
});

test('circle: borrower, nominee and the people the borrower follows can see it', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openRequest(s);
    const gus = await s.me('gus');
    await s.follow('ann', gus.id);       // the borrower chose gus
    for (const who of ['ann', 'nat', 'gus']) {
      assert.equal((await s.call(who, 'GET', `/requests/${id}`)).status, 200, who);
    }
    assert.ok(ann.id);
  } finally { await s.close(); }
});

test('circle: following the borrower yourself does NOT give access (following needs no approval)', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openRequest(s);
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.me('fay');
    await s.follow('fay', ann.id);
    assert.equal((await s.call('fay', 'GET', `/requests/${id}`)).status, 404);
    assert.equal((await s.call('fay', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 10 })).status, 404);
    assert.equal((await s.call('fay', 'GET', '/feed')).body.requests.length, 0, 'not in the feed either');
  } finally { await s.close(); }
});

test('circle: inside the circle, only the borrower or nominee may record a repayment (403)', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openRequest(s);
    const gus = await s.me('gus');
    await s.follow('ann', gus.id);
    assert.equal((await s.call('gus', 'POST', `/requests/${id}/repayments`, { amount: 10 })).status, 403);
  } finally { await s.close(); }
});

test('circle: an unrelated verifier cannot act on a request that is no longer pending (404)', async () => {
  const s = await setup();
  try {
    const { id } = await openRequest(s);
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const xia = await s.me('xia'); await s.repo.setVerifier(xia.id, true);
    assert.equal((await s.call('xia', 'POST', `/requests/${id}/verify`, { decision: 'reject' })).status, 404);
  } finally { await s.close(); }
});

test('circle: verifiers see requests awaiting verification, and ones they decided', async () => {
  const s = await setup();
  try {
    const { id } = await openRequest(s);
    assert.equal((await s.call('vee', 'GET', `/requests/${id}`)).status, 200, 'pending: any verifier');
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal((await s.call('vee', 'GET', `/requests/${id}`)).status, 200, 'decided by vee');
    const xia = await s.me('xia'); await s.repo.setVerifier(xia.id, true);
    assert.equal((await s.call('xia', 'GET', `/requests/${id}`)).status, 404, 'open request, unrelated verifier');
  } finally { await s.close(); }
});

test('circle: someone who already lent keeps access after the connection ends', async () => {
  const s = await setup();
  try {
    const { ann, id } = await openRequest(s);
    await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    await s.call('wes', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    const lee = await s.me('lee');
    await s.follow('ann', lee.id);
    assert.equal((await s.call('lee', 'POST', `/requests/${id}/contributions`, { confirmedContact: true, amount: 10 })).status, 201);
    await s.call('ann', 'DELETE', `/follows/${lee.id}`);
    assert.equal((await s.call('lee', 'GET', `/requests/${id}`)).status, 200);
  } finally { await s.close(); }
});

// ---- Shareable invites ----

test('invites: a link invite returns a URL; accepting it connects both people both ways', async () => {
  const s = await setup();
  try {
    const ann = await s.me('ann');
    const made = await s.call('ann', 'POST', '/invites', {});
    assert.equal(made.status, 201);
    const token = new URL(made.body.link).searchParams.get('invite');
    assert.match(made.body.link, /^https:\/\/ff\.test\/\?invite=/);
    const bo = await s.me('bo');
    const accepted = await s.call('bo', 'POST', '/invites/accept', { token });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.inviter.name, 'ann');
    const c = (await s.call('bo', 'GET', '/connections')).body;
    assert.deepEqual(c.mutual.map((u) => u.id), [ann.id]);
    // The same family link can be shared in a group chat.
    await s.me('cy');
    assert.equal((await s.call('cy', 'POST', '/invites/accept', { token })).status, 200);
    assert.ok(bo.id);
  } finally { await s.close(); }
});

test('invites: email invites still work and also return the link', async () => {
  const s = await setup();
  try {
    await s.me('ann');
    const r = await s.call('ann', 'POST', '/invites', { email: 'new@example.com' });
    assert.equal(r.status, 201);
    assert.match(r.body.link, /\?invite=/);
  } finally { await s.close(); }
});

test('invites: a link older than 30 days has expired (410)', async () => {
  const s = await setup();
  try {
    await s.me('ann');
    const token = new URL((await s.call('ann', 'POST', '/invites', {})).body.link).searchParams.get('invite');
    (await s.repo.getInviteByToken(token)).createdAt = '2026-10-01T00:00:00Z';
    await s.me('bo');
    assert.equal((await s.call('bo', 'POST', '/invites/accept', { token })).status, 410);
  } finally { await s.close(); }
});

test('invites: unknown tokens and your own link are refused', async () => {
  const s = await setup();
  try {
    await s.me('ann');
    assert.equal((await s.call('ann', 'POST', '/invites/accept', { token: 'nope' })).status, 404);
    const token = new URL((await s.call('ann', 'POST', '/invites', {})).body.link).searchParams.get('invite');
    assert.equal((await s.call('ann', 'POST', '/invites/accept', { token })).status, 400);
  } finally { await s.close(); }
});

// ---- Suggestions ----

test('suggestions: people who follow you come first, then people your connections follow, ranked by count', async () => {
  const s = await setup();
  try {
    const me = await s.me('me'); const a = await s.me('a'); const b = await s.me('b');
    const fan = await s.me('fan'); const two = await s.me('two'); const one = await s.me('one'); await s.me('loner');
    await s.follow('me', a.id); await s.follow('me', b.id);   // I follow a and b
    await s.follow('fan', me.id);                              // follows me; I do not follow back
    await s.follow('a', two.id); await s.follow('b', two.id);  // a and b both chose two
    await s.follow('a', one.id);                               // only a chose one
    const r = await s.call('me', 'GET', '/suggestions');
    assert.equal(r.status, 200);
    const ids = r.body.suggestions.map((x) => x.user.id);
    assert.deepEqual(ids, [fan.id, two.id, one.id]);
    assert.equal(r.body.suggestions[0].reason, 'Follows you');
    assert.equal(r.body.suggestions[1].mutualCount, 2);
    assert.deepEqual(r.body.suggestions[1].mutualNames.sort(), ['a', 'b']);
    for (const x of r.body.suggestions) assert.equal(x.user.email, undefined, 'no emails of other members');
  } finally { await s.close(); }
});

test('suggestions: following many people cannot fake "mutual connections"', async () => {
  const s = await setup();
  try {
    const me = await s.me('me'); const a = await s.me('a'); const b = await s.me('b'); await s.me('spam');
    await s.follow('me', a.id); await s.follow('me', b.id);
    await s.follow('spam', a.id); await s.follow('spam', b.id);  // spam follows my connections; they did not choose spam
    const ids = (await s.call('me', 'GET', '/suggestions')).body.suggestions.map((x) => x.user.name);
    assert.deepEqual(ids, []);
  } finally { await s.close(); }
});

test('suggestions: never suggests yourself or people you already follow', async () => {
  const s = await setup();
  try {
    const me = await s.me('me'); const a = await s.me('a'); const b = await s.me('b');
    await s.follow('me', a.id); await s.follow('me', b.id); await s.follow('a', b.id); await s.follow('a', me.id);
    const ids = (await s.call('me', 'GET', '/suggestions')).body.suggestions.map((x) => x.user.id);
    assert.deepEqual(ids, []);
  } finally { await s.close(); }
});
