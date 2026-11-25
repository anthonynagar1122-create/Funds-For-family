'use strict';
// Sign-in rate limit: failed attempts (no sign-in, or an invite-only refusal) are limited per address.
// Invites and member search are not limited. The limiter is in memory per serverless instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { createFailureLimiter } = require('../src/rate-limit');

test('repeated failed sign-ins are blocked with 429 and Retry-After', async () => {
  const s = await setup({ rateLimits: { auth: { max: 3, windowMs: 60000 } } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await s.call(null, 'GET', '/me')).status, 401);
    const blocked = await s.call(null, 'GET', '/me');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  } finally { await s.close(); }
});

test('successful sign-ins never count toward the limit', async () => {
  const s = await setup({ rateLimits: { auth: { max: 2, windowMs: 60000 } } });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await s.call('ann', 'GET', '/me')).status, 200);
  } finally { await s.close(); }
});

test('invites and member search are not rate limited', async () => {
  const s = await setup({ rateLimits: { auth: { max: 1000, windowMs: 60000 } } });
  try {
    // Ten invites from five members, two each: stays under the monthly invite allowance (a separate product rule),
    // so the only thing this checks is that the sign-in limit does not apply to invites.
    let n = 0;
    for (const who of ['ann', 'bo', 'cy', 'di', 'ed']) {
      await s.call(who, 'GET', '/me');
      for (let i = 0; i < 2; i += 1) {
        n += 1;
        assert.equal((await s.call(who, 'POST', '/invites', { email: `guest${n}@example.com` })).status, 201, `invite ${n}`);
      }
    }
    await s.call('ann', 'GET', '/me');
    for (let i = 0; i < 70; i += 1) assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 200, `search ${i}`);
  } finally { await s.close(); }
});

test('the failure limiter starts a new window when the old one ends', () => {
  let t = 0;
  const limiter = createFailureLimiter({ windowMs: 1000, max: 1, key: () => 'k', now: () => t });
  const req = {};
  assert.equal(limiter.retryAfterSeconds(req), 0);
  limiter.failed(req);
  assert.ok(limiter.retryAfterSeconds(req) >= 1, 'blocked after one failure at the limit');
  t = 1000;
  assert.equal(limiter.retryAfterSeconds(req), 0, 'a new window starts after the reset time');
});
