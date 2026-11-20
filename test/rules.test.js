'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/rules');

const NOW = new Date('2026-11-20T12:00:00Z');

test('interest is zero on and before the due date', () => {
  assert.equal(r.interestCents(100000, '2026-11-20', NOW), 0);
  assert.equal(r.interestCents(100000, '2026-12-01', NOW), 0);
});

test('interest accrues daily after the due date (simple, 12% p.a.)', () => {
  // 1000.00 principal, 10 days late: 100000 * 0.12 * 10 / 365 = 328.77 -> 329 cents rounded
  assert.equal(r.daysOverdue('2026-11-10', NOW), 10);
  assert.equal(r.interestCents(100000, '2026-11-10', NOW), 329);
  assert.equal(r.amountDueCents(100000, '2026-11-10', NOW), 100329);
});

test('amount due honours a custom rate', () => {
  assert.equal(r.interestCents(100000, '2026-11-10', NOW, 0), 0);
});

test('validateRequest accepts a complete request and converts to cents', () => {
  const { errors, value } = r.validateRequest(
    { amount: 250.5, purpose: 'Repairs to the family car after an accident', repaymentDate: '2027-03-01', nomineeId: 'user_b' },
    { borrowerId: 'user_a', now: NOW },
  );
  assert.deepEqual(errors, {});
  assert.equal(value.principalCents, 25050);
});

test('validateRequest rejects every bad field', () => {
  const { errors } = r.validateRequest(
    { amount: -1, purpose: 'short', repaymentDate: '2026-11-01', nomineeId: 'user_a' },
    { borrowerId: 'user_a', now: NOW },
  );
  assert.deepEqual(Object.keys(errors).sort(), ['amount', 'nomineeId', 'purpose', 'repaymentDate']);
});

test('validateRequest rejects amounts with more than 2 decimals and impossible dates', () => {
  const a = r.validateRequest({ amount: 1.234, purpose: 'x'.repeat(25), repaymentDate: '2027-02-30', nomineeId: 'u' }, { borrowerId: 'b', now: NOW });
  assert.ok(a.errors.amount);
  assert.ok(a.errors.repaymentDate);
});

test('two distinct approvals approve; a single rejection rejects', () => {
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }]), 'pending');
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v2', decision: 'approve' }]), 'approved');
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v2', decision: 'reject' }]), 'rejected');
});

test('the same verifier counted once', () => {
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v1', decision: 'approve' }]), 'pending');
});

test('canVerify blocks non-verifiers, the borrower, the nominee, and decided requests', () => {
  const base = { requestBorrowerId: 'b', requestNomineeId: 'n', requestStatus: 'pending_verification' };
  assert.equal(r.canVerify({ ...base, verifier: { id: 'v', isVerifier: false } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'b', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'n', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, requestStatus: 'open', verifier: { id: 'v', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'v', isVerifier: true } }).ok, true);
});

test('contributions are capped at the remaining amount and only on open requests', () => {
  const base = { principalCents: 10000, raisedCents: 6000, contributorId: 'c', borrowerId: 'b', status: 'open' };
  assert.equal(r.checkContribution({ ...base, amountCents: 4000 }).ok, true);
  assert.equal(r.checkContribution({ ...base, amountCents: 4001 }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 100, contributorId: 'b' }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 100, status: 'funded' }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 0 }).ok, false);
});

test('effectiveStatus derives overdue for funded requests past the repayment date', () => {
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-11-10' }, NOW), 'overdue');
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-12-10' }, NOW), 'funded');
  assert.equal(r.effectiveStatus({ status: 'repaid', repaymentDate: '2026-11-10' }, NOW), 'repaid');
});
