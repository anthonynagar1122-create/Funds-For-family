'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('../src/memory-repo');

async function fixture(status = 'open') {
  const repo = createMemoryRepo();
  const borrower = await repo.createUser({ clerkId: `b-${Math.random()}`, name: 'Borrower', email: `b-${Math.random()}@test.invalid` });
  const contact = await repo.createUser({ clerkId: `c-${Math.random()}`, name: 'Contact', email: `c-${Math.random()}@test.invalid` });
  const lender = await repo.createUser({ clerkId: `l-${Math.random()}`, name: 'Lender', email: `l-${Math.random()}@test.invalid` });
  await repo.addFollow(lender.id, borrower.id);
  await repo.addFollow(borrower.id, lender.id);
  const request = await repo.createRequest({ borrowerId: borrower.id, trustedContactId: contact.id,
    purpose: 'School fees for the second term at college', principalCents: 50000,
    repaymentDate: '2027-03-01', status });
  return { repo, borrower, contact, lender, request };
}

test('contribution creation is capped under concurrent writes and idempotent on retry', async () => {
  const f = await fixture('open');
  const input = (amountCents, idempotencyKey) => ({ requestId: f.request.id, contributorId: f.lender.id,
    amountCents, utr: null, idempotencyKey });
  const outcomes = await Promise.allSettled([
    f.repo.recordContribution(input(30000, 'concurrent-contrib-a')),
    f.repo.recordContribution(input(30000, 'concurrent-contrib-b')),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((x) => x.status === 'rejected').length, 1);
  const rows = await f.repo.listContributions(f.request.id);
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 30000);
  const key = 'retry-contribution-001';
  const first = await f.repo.recordContribution(input(10000, key));
  const replay = await f.repo.recordContribution(input(10000, key));
  assert.equal(replay.id, first.id);
  await assert.rejects(() => f.repo.recordContribution(input(9000, key)), { code: '22023' });
});

test('repayment creation reserves each lender position atomically and supports idempotent retries', async () => {
  const f = await fixture('funded');
  await f.repo.addContribution({ requestId: f.request.id, contributorId: f.lender.id, amountCents: 50000, status: 'confirmed' });
  const input = (amountCents, idempotencyKey) => ({ requestId: f.request.id, payerId: f.borrower.id,
    lenderId: f.lender.id, amountCents, utr: null, idempotencyKey });
  const outcomes = await Promise.allSettled([
    f.repo.recordRepayment(input(30000, 'concurrent-repay-a')),
    f.repo.recordRepayment(input(30000, 'concurrent-repay-b')),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((x) => x.status === 'rejected').length, 1);
  const rows = await f.repo.listRepayments(f.request.id);
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 30000);
  const key = 'retry-repayment-001';
  const first = await f.repo.recordRepayment(input(10000, key));
  const replay = await f.repo.recordRepayment(input(10000, key));
  assert.equal(replay.id, first.id);
  await assert.rejects(() => f.repo.recordRepayment(input(9000, key)), { code: '22023' });
});
