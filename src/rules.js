'use strict';
// Pure business rules. No I/O: safe to unit-test and to reuse on server and client.

const PURPOSE_MIN_LENGTH = 20;
const PURPOSE_MAX_LENGTH = 2000;
const AMOUNT_MAX = 1000000;        // dollars; keeps cents well inside the 32-bit integer column
const DEFAULT_ANNUAL_RATE = 0.12;   // ⚠ assumption, see docs/01-idea.md
const DEFAULT_REQUIRED_APPROVALS = 2;
const MS_PER_DAY = 86400000;

// Feed visibility mode. 'followings_and_followers' matches the handwritten notes
// ("followings and followers"); 'mutual' would show only people who follow each other.
const FEED_MODE = 'followings_and_followers';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function dayNumber(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / MS_PER_DAY);
}

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

/** Whole days the repayment is late. 0 on or before the due date. */
function daysOverdue(dueDate, now) {
  return Math.max(0, dayNumber(todayUtc(now)) - dayNumber(dueDate));
}

/** Simple interest, accrued daily after the due date. Integer cents. */
function interestCents(principalCents, dueDate, now, annualRate = DEFAULT_ANNUAL_RATE) {
  const days = daysOverdue(dueDate, now);
  if (days === 0) return 0;
  return Math.round((principalCents * annualRate * days) / 365);
}

function amountDueCents(principalCents, dueDate, now, annualRate = DEFAULT_ANNUAL_RATE) {
  return principalCents + interestCents(principalCents, dueDate, now, annualRate);
}

/**
 * Validate a new funding request. Returns { errors, value }.
 * errors is an object keyed by field name; empty object means valid.
 */
function validateRequest(input, { borrowerId, now }) {
  const errors = {};
  const value = {};

  const amount = Number(input?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.amount = 'Amount must be a positive number';
  } else if (amount > AMOUNT_MAX) {
    errors.amount = `Amount cannot exceed ${AMOUNT_MAX}`;
  } else if (Math.round(amount * 100) !== amount * 100) {
    errors.amount = 'Amount can have at most 2 decimal places';
  } else {
    value.principalCents = Math.round(amount * 100);
  }

  const purpose = typeof input?.purpose === 'string' ? input.purpose.trim() : '';
  if (purpose.length < PURPOSE_MIN_LENGTH) {
    errors.purpose = `Describe the purpose in at least ${PURPOSE_MIN_LENGTH} characters`;
  } else if (purpose.length > PURPOSE_MAX_LENGTH) {
    errors.purpose = `Keep the purpose under ${PURPOSE_MAX_LENGTH} characters`;
  } else {
    value.purpose = purpose;
  }

  if (!isIsoDate(input?.repaymentDate)) {
    errors.repaymentDate = 'Repayment date must be a valid YYYY-MM-DD date';
  } else if (input.repaymentDate <= todayUtc(now)) {
    errors.repaymentDate = 'Repayment date must be after today';
  } else {
    value.repaymentDate = input.repaymentDate;
  }

  if (!input?.nomineeId) {
    errors.nomineeId = 'Choose a nominee who will repay if the borrower cannot';
  } else if (input.nomineeId === borrowerId) {
    errors.nomineeId = 'The nominee cannot be the borrower';
  } else {
    value.nomineeId = input.nomineeId;
  }

  return { errors, value };
}

/** Outcome of verifications. Any rejection wins; otherwise enough distinct approvals. */
function verificationOutcome(verifications, requiredApprovals = DEFAULT_REQUIRED_APPROVALS) {
  const byVerifier = new Map();
  for (const v of verifications) byVerifier.set(v.verifierId, v.decision);
  const decisions = [...byVerifier.values()];
  if (decisions.includes('reject')) return 'rejected';
  const approvals = decisions.filter((d) => d === 'approve').length;
  return approvals >= requiredApprovals ? 'approved' : 'pending';
}

/** Whether a verifier may decide on a request. */
function canVerify({ verifier, requestBorrowerId, requestNomineeId, requestStatus }) {
  if (!verifier?.isVerifier) return { ok: false, reason: 'Only verification team members can verify' };
  if (verifier.id === requestBorrowerId || verifier.id === requestNomineeId) {
    return { ok: false, reason: 'You cannot verify your own request' };
  }
  if (requestStatus !== 'pending_verification') {
    return { ok: false, reason: 'This request is no longer awaiting verification' };
  }
  return { ok: true };
}

/** Contribution cap. Returns { ok, reason?, remainingCents }. */
function checkContribution({ amountCents, principalCents, raisedCents, contributorId, borrowerId, status }) {
  const remainingCents = Math.max(0, principalCents - raisedCents);
  if (contributorId === borrowerId) return { ok: false, reason: 'You cannot fund your own request', remainingCents };
  if (status !== 'open') return { ok: false, reason: 'This request is not accepting contributions', remainingCents };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'Contribution must be a positive amount', remainingCents };
  }
  if (amountCents > remainingCents) {
    return { ok: false, reason: `Only ${remainingCents} cents remain to be funded`, remainingCents };
  }
  return { ok: true, remainingCents };
}

/** Stored status plus derived 'overdue'. */
function effectiveStatus(request, now) {
  if (request.status === 'funded' && daysOverdue(request.repaymentDate, now) > 0) return 'overdue';
  return request.status;
}

/** Which statuses appear in the public feed. */
function isFeedStatus(status) {
  return status === 'open' || status === 'funded' || status === 'repaid';
}

module.exports = {
  PURPOSE_MIN_LENGTH,
  PURPOSE_MAX_LENGTH,
  AMOUNT_MAX,
  DEFAULT_ANNUAL_RATE,
  DEFAULT_REQUIRED_APPROVALS,
  FEED_MODE,
  isIsoDate,
  daysOverdue,
  interestCents,
  amountDueCents,
  validateRequest,
  verificationOutcome,
  canVerify,
  checkContribution,
  effectiveStatus,
  isFeedStatus,
};
