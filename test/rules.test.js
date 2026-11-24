'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/rules');

const NOW = new Date('2026-11-23T06:00:00Z');
const LATE = new Date('2026-11-23T20:00:00Z'); // already 24 November in India

const valid = (extra = {}) => ({
  amount: 500,
  purpose: 'Repairs to the family car after an accident',
  category: 'medical',
  repaymentDate: '2027-03-01',
  trustedContactId: 'user_b',
  ...extra,
});
const check = (input, now = NOW) => r.validateRequest(input, { borrowerId: 'user_a', now });

test('todayIst is the calendar date in India', () => {
  assert.equal(r.todayIst(new Date('2026-11-23T20:00:00Z')), '2026-11-24');
  assert.equal(r.todayIst(new Date('2026-11-23T18:29:59Z')), '2026-11-23');
});

test('addMonths clamps to the end of the month', () => {
  assert.equal(r.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(r.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(r.addMonths('2026-11-23', 12), '2027-11-23');
  assert.equal(r.addMonths('2026-12-15', 1), '2027-01-15');
});

test('validateRequest accepts a complete request and converts to paise', () => {
  const { errors, value } = check(valid({ amount: '250.50' }));
  assert.deepEqual(errors, {});
  assert.deepEqual(value, {
    principalCents: 25050,
    purpose: 'Repairs to the family car after an accident',
    category: 'medical',
    repaymentDate: '2027-03-01',
    trustedContactId: 'user_b',
  });
});

test('amount limits are Rs 100 to Rs 50,000 inclusive', () => {
  const msg = 'Enter an amount from ₹100 to ₹50,000';
  assert.equal(check(valid({ amount: '99.99' })).errors.amount, msg);
  assert.equal(check(valid({ amount: '50000.01' })).errors.amount, msg);
  assert.equal(check(valid({ amount: 'abc' })).errors.amount, msg);
  assert.equal(check(valid({ amount: '100' })).value.principalCents, 10000);
  assert.equal(check(valid({ amount: '50,000' })).value.principalCents, 5000000);
});

test('repayment date must be after today and within 12 months (IST)', () => {
  assert.equal(check(valid({ repaymentDate: '2026-11-23' })).errors.repaymentDate, 'Repayment date must be after today');
  assert.equal(check(valid({ repaymentDate: '2027-11-23' })).errors.repaymentDate, undefined);
  assert.equal(check(valid({ repaymentDate: '2027-11-24' })).errors.repaymentDate, 'Choose a date within 12 months');
  assert.ok(check(valid({ repaymentDate: '2027-02-30' })).errors.repaymentDate);
  // Late evening UTC is already the 24th in India, so the 24th is not "after today".
  assert.equal(check(valid({ repaymentDate: '2026-11-24' }), LATE).errors.repaymentDate, 'Repayment date must be after today');
  assert.equal(check(valid({ repaymentDate: '2026-11-25' }), LATE).errors.repaymentDate, undefined);
});

test('category must be on the list', () => {
  assert.equal(check(valid({ category: 'travel' })).errors.category, 'Choose a category');
  assert.equal(check(valid({ category: undefined })).errors.category, 'Choose a category');
  assert.equal(check(valid({ category: 'medical' })).value.category, 'medical');
});

test('trusted contact is required and cannot be the borrower', () => {
  assert.equal(check(valid({ trustedContactId: undefined })).errors.trustedContactId, 'Choose a trusted contact');
  assert.equal(check(valid({ trustedContactId: 'user_a' })).errors.trustedContactId, 'Choose a trusted contact');
});

test('purpose length is enforced', () => {
  assert.ok(check(valid({ purpose: 'short' })).errors.purpose);
  assert.ok(check(valid({ purpose: 'x'.repeat(2001) })).errors.purpose);
});

test('every bad field is reported', () => {
  const { errors } = check({ amount: -1, purpose: 'short', category: 'x', repaymentDate: '2026-11-01', trustedContactId: 'user_a' });
  assert.deepEqual(Object.keys(errors).sort(), ['amount', 'category', 'purpose', 'repaymentDate', 'trustedContactId']);
});

test('only one active request per borrower', () => {
  assert.equal(r.checkCanCreateRequest({ borrowerActiveCount: 1 }).ok, false);
  assert.equal(r.checkCanCreateRequest({ borrowerActiveCount: 1 }).reason, 'You already have an active request. Finish or withdraw it first.');
  assert.equal(r.checkCanCreateRequest({ borrowerActiveCount: 0 }).ok, true);
});

test('trusted contact must be mutual and carry at most 3 active requests', () => {
  const base = { borrowerId: 'a', contactId: 'b', isMutual: true, contactActiveCount: 2 };
  assert.equal(r.checkTrustedContact(base).ok, true);
  const notMutual = r.checkTrustedContact({ ...base, isMutual: false });
  assert.equal(notMutual.ok, false);
  assert.equal(notMutual.reason, 'Your trusted contact must be someone you follow who follows you back');
  const busy = r.checkTrustedContact({ ...base, contactActiveCount: 3 });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'This person is already the trusted contact on 3 requests');
  assert.equal(r.checkTrustedContact({ ...base, contactId: 'a' }).ok, false);
});

test('a rejection needs a reason of 10 to 500 characters; approval does not', () => {
  assert.ok(r.validateVerification({ decision: 'reject', reason: 'short' }).errors.reason);
  assert.ok(r.validateVerification({ decision: 'reject' }).errors.reason);
  assert.ok(r.validateVerification({ decision: 'reject', reason: 'x'.repeat(501) }).errors.reason);
  assert.deepEqual(r.validateVerification({ decision: 'reject', reason: 'Documents do not match' }).errors, {});
  assert.deepEqual(r.validateVerification({ decision: 'approve' }).errors, {});
  assert.ok(r.validateVerification({ decision: 'maybe' }).errors.decision);
});

test('two distinct approvals approve; a single rejection rejects', () => {
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }]), 'pending');
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v2', decision: 'approve' }]), 'approved');
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v2', decision: 'reject' }]), 'rejected');
});

test('the same verifier counted once', () => {
  assert.equal(r.verificationOutcome([{ verifierId: 'v1', decision: 'approve' }, { verifierId: 'v1', decision: 'approve' }]), 'pending');
});

test('canVerify blocks non-verifiers, the borrower, the trusted contact, and decided requests', () => {
  const base = { borrowerId: 'b', trustedContactId: 'n', status: 'pending_verification' };
  assert.equal(r.canVerify({ ...base, verifier: { id: 'v', isVerifier: false } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'b', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'n', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, status: 'open', verifier: { id: 'v', isVerifier: true } }).ok, false);
  assert.equal(r.canVerify({ ...base, verifier: { id: 'v', isVerifier: true } }).ok, true);
});

test('contributions are capped at the remaining amount and only on open requests', () => {
  const base = { principalCents: 10000, totals: { confirmedCents: 6000, pendingCents: 0 }, isMutual: true, contributorId: 'c', borrowerId: 'b', status: 'open' };
  assert.equal(r.checkContribution({ ...base, amountCents: 4000 }).ok, true);
  assert.equal(r.checkContribution({ ...base, amountCents: 4001 }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 100, contributorId: 'b' }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 100, status: 'funded' }).ok, false);
  assert.equal(r.checkContribution({ ...base, amountCents: 0 }).ok, false);
});

test('effectiveStatus derives overdue for funded requests past the repayment date in IST', () => {
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-11-10' }, NOW), 'overdue');
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-12-10' }, NOW), 'funded');
  assert.equal(r.effectiveStatus({ status: 'repaid', repaymentDate: '2026-11-10' }, NOW), 'repaid');
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-11-23' }, NOW), 'funded');
  assert.equal(r.effectiveStatus({ status: 'funded', repaymentDate: '2026-11-23' }, new Date('2026-11-23T19:00:00Z')), 'overdue');
});

test('interest is gone', () => {
  assert.equal(r.interestCents, undefined);
  assert.equal(r.amountDueCents, undefined);
  assert.equal(r.DEFAULT_ANNUAL_RATE, undefined);
});

// ---- Task 3: money flow and visibility ----

const TOTALS = r.fundingTotals([
  { amountCents: 500, status: 'confirmed' },
  { amountCents: 300, status: 'sent' },
  { amountCents: 900, status: 'not_received' },
]);

test('validateUtr allows empty and 6-35 alphanumerics only', () => {
  assert.equal(r.validateUtr(''), true);
  assert.equal(r.validateUtr(undefined), true);
  assert.equal(r.validateUtr('AB12CD'), true);
  assert.equal(r.validateUtr('A'.repeat(35)), true);
  assert.equal(r.validateUtr('A'.repeat(36)), false);
  assert.equal(r.validateUtr('ABC12'), false);
  assert.equal(r.validateUtr('ABC-123'), false);
  assert.deepEqual(r.ENTRY_STATUSES, ['sent', 'confirmed', 'not_received', 'removed']);
});

test('fundingTotals counts confirmed and sent, not not_received', () => {
  assert.deepEqual(TOTALS, { confirmedCents: 500, pendingCents: 300 });
});

const contrib = (extra = {}) => r.checkContribution({
  amountCents: 200, principalCents: 1000, totals: TOTALS, contributorId: 5, borrowerId: 1,
  isMutual: true, status: 'open', ...extra,
});

test('checkContribution caps at principal - confirmed - pending', () => {
  assert.equal(contrib().ok, true);
  assert.equal(contrib().remainingCents, 200);
  const over = contrib({ amountCents: 201 });
  assert.equal(over.ok, false);
  assert.equal(over.remainingCents, 200);
});

test('checkContribution rejects non-mutual, borrower, non-open and bad amounts', () => {
  assert.equal(contrib({ isMutual: false }).ok, false);
  assert.equal(contrib({ contributorId: 1 }).ok, false);
  assert.equal(contrib({ status: 'funded' }).ok, false);
  assert.equal(contrib({ amountCents: 0 }).ok, false);
  assert.equal(contrib({ amountCents: 1.5 }).ok, false);
});

const CONTRIBS = [{ lenderId: 7, amountCents: 1000, status: 'confirmed' }, { lenderId: 7, amountCents: 50, status: 'sent' }];
const REPAYS = [
  { lenderId: 7, amountCents: 400, status: 'confirmed' },
  { lenderId: 7, amountCents: 100, status: 'sent' },
  { lenderId: 7, amountCents: 999, status: 'not_received' },
];

test('owedByLender uses confirmed for lent and repaid, sent for pending', () => {
  const m = r.owedByLender(CONTRIBS, REPAYS);
  assert.deepEqual(m.get(7), { lentCents: 1000, repaidCents: 400, pendingRepayCents: 100, owedCents: 600 });
});

test('checkRepayment bounds by owed minus pending and restricts payer', () => {
  const owed = r.owedByLender(CONTRIBS, REPAYS).get(7);
  const base = { amountCents: 500, payerId: 1, borrowerId: 1, trustedContactId: 2, lenderId: 7, owed, status: 'funded' };
  assert.equal(r.checkRepayment(base).ok, true);
  assert.equal(r.checkRepayment({ ...base, payerId: 2 }).ok, true);
  assert.equal(r.checkRepayment({ ...base, amountCents: 501 }).ok, false);
  assert.equal(r.checkRepayment({ ...base, payerId: 99 }).ok, false);
  assert.equal(r.checkRepayment({ ...base, status: 'open' }).ok, false);
  assert.equal(r.checkRepayment({ ...base, owed: undefined }).ok, false);
});

test('isFullyRepaid needs a non-empty map with everything at zero', () => {
  assert.equal(r.isFullyRepaid(new Map()), false);
  const done = r.owedByLender([{ lenderId: 7, amountCents: 100, status: 'confirmed' }], [{ lenderId: 7, amountCents: 100, status: 'confirmed' }]);
  assert.equal(r.isFullyRepaid(done), true);
  assert.equal(r.isFullyRepaid(r.owedByLender(CONTRIBS, REPAYS)), false);
});

test('isMutual needs both directions', () => {
  assert.equal(r.isMutual({ following: [1, 2], followers: [2, 3] }, 2), true);
  assert.equal(r.isMutual({ following: [1, 2], followers: [3] }, 2), false);
  assert.equal(r.isMutual({ following: [], followers: [2] }, 2), false);
});

const STATUSES = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open', 'funded', 'repaid', 'rejected'];
const see = (status, extra = {}) => r.canSeeRequest({
  viewerId: 50, request: { borrowerId: 1, trustedContactId: 2, status },
  isMutualWithBorrower: false, isLender: false, viewerIsVerifier: false, ...extra,
});

test('canSeeRequest: stranger sees nothing', () => {
  for (const s of STATUSES) assert.equal(see(s), false, s);
});

test('canSeeRequest: borrower, trusted contact and lenders always', () => {
  for (const s of STATUSES) {
    assert.equal(see(s, { viewerId: 1 }), true, s);
    assert.equal(see(s, { viewerId: 2 }), true, s);
    assert.equal(see(s, { isLender: true }), true, s);
  }
});

test('canSeeRequest: mutual connection on open, funded, repaid only', () => {
  for (const s of STATUSES) {
    assert.equal(see(s, { isMutualWithBorrower: true }), ['open', 'funded', 'repaid'].includes(s), s);
  }
});

test('canSeeRequest: verifier only while pending_verification', () => {
  for (const s of STATUSES) assert.equal(see(s, { viewerIsVerifier: true }), s === 'pending_verification', s);
});

test('paymentTargetVisible: owner always sees own', () => {
  const request = { borrowerId: 1, trustedContactId: 2, status: 'rejected' };
  assert.equal(r.paymentTargetVisible({ viewerId: 1, ownerId: 1, request, lenderIds: [] }), true);
  assert.equal(r.paymentTargetVisible({ viewerId: 7, ownerId: 7, request, lenderIds: [7] }), true);
});

test('paymentTargetVisible: borrower UPI to lenders, and to mutuals only while open', () => {
  const pv = (status, extra) => r.paymentTargetVisible({
    viewerId: 50, ownerId: 1, request: { borrowerId: 1, trustedContactId: 2, status }, lenderIds: [7], isMutualWithOwner: false, ...extra,
  });
  assert.equal(pv('funded', { viewerId: 7 }), true);
  assert.equal(pv('open', { isMutualWithOwner: true }), true);
  assert.equal(pv('funded', { isMutualWithOwner: true }), false);
  assert.equal(pv('pending_verification', { isMutualWithOwner: true }), false);
  assert.equal(pv('open'), false);
});

test('paymentTargetVisible: lender UPI to borrower and trusted contact only', () => {
  const pv = (viewerId, extra) => r.paymentTargetVisible({
    viewerId, ownerId: 7, request: { borrowerId: 1, trustedContactId: 2, status: 'funded' }, lenderIds: [7, 8], isMutualWithOwner: true, ...extra,
  });
  assert.equal(pv(1), true);
  assert.equal(pv(2), true);
  assert.equal(pv(8), false);
  assert.equal(pv(50), false);
});
