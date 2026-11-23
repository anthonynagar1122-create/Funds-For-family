'use strict';
// Pure business rules. No I/O: safe to unit-test and to reuse on server and client.

const { parseRupees } = require('../public/app/money');

const PURPOSE_MIN_LENGTH = 20;
const PURPOSE_MAX_LENGTH = 2000;
const AMOUNT_MIN_PAISE = 10000;     // Rs 100
const AMOUNT_MAX_PAISE = 5000000;   // Rs 50,000
const CATEGORIES = ['education', 'medical', 'home', 'family_event', 'work', 'emergency', 'other'];
const ACTIVE_STATUSES = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open', 'funded'];
const MAX_ACTIVE_AS_CONTACT = 3;
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;
const DEFAULT_REQUIRED_APPROVALS = 2;
const MS_PER_DAY = 86400000;
const IST_OFFSET_MS = 330 * 60000;  // Asia/Kolkata, UTC+05:30, no daylight saving

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function dayNumber(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / MS_PER_DAY);
}

/** Calendar date in India, 'YYYY-MM-DD'. */
function todayIst(now) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Add whole months to a 'YYYY-MM-DD' date, clamped to the month end (2026-01-31 + 1 = 2026-02-28). */
function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (v, w) => String(v).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(Math.min(d, lastDay), 2)}`;
}

/** Whole days the repayment is late. 0 on or before the due date. */
function daysOverdue(dueDate, now) {
  return Math.max(0, dayNumber(todayIst(now)) - dayNumber(dueDate));
}

/**
 * Validate a new funding request. Returns { errors, value }.
 * errors is an object keyed by field name; empty object means valid.
 */
function validateRequest(input, { borrowerId, now }) {
  const errors = {};
  const value = {};

  const parsed = parseRupees(input?.amount);
  if (parsed.error || parsed.paise < AMOUNT_MIN_PAISE || parsed.paise > AMOUNT_MAX_PAISE) {
    errors.amount = 'Enter an amount from ₹100 to ₹50,000';
  } else {
    value.principalCents = parsed.paise;
  }

  const purpose = typeof input?.purpose === 'string' ? input.purpose.trim() : '';
  if (purpose.length < PURPOSE_MIN_LENGTH) {
    errors.purpose = `Describe the purpose in at least ${PURPOSE_MIN_LENGTH} characters`;
  } else if (purpose.length > PURPOSE_MAX_LENGTH) {
    errors.purpose = `Keep the purpose under ${PURPOSE_MAX_LENGTH} characters`;
  } else {
    value.purpose = purpose;
  }

  if (!CATEGORIES.includes(input?.category)) {
    errors.category = 'Choose a category';
  } else {
    value.category = input.category;
  }

  const today = todayIst(now);
  if (!isIsoDate(input?.repaymentDate)) {
    errors.repaymentDate = 'Repayment date must be a valid YYYY-MM-DD date';
  } else if (input.repaymentDate <= today) {
    errors.repaymentDate = 'Repayment date must be after today';
  } else if (input.repaymentDate > addMonths(today, 12)) {
    errors.repaymentDate = 'Choose a date within 12 months';
  } else {
    value.repaymentDate = input.repaymentDate;
  }

  if (!input?.trustedContactId) {
    errors.trustedContactId = 'Choose a trusted contact';
  } else if (input.trustedContactId === borrowerId) {
    errors.trustedContactId = 'Choose a trusted contact';
  } else {
    value.trustedContactId = input.trustedContactId;
  }

  return { errors, value };
}

/** A borrower may have one active request at a time. */
function checkCanCreateRequest({ borrowerActiveCount }) {
  if (borrowerActiveCount >= 1) {
    return { ok: false, reason: 'You already have an active request. Finish or withdraw it first.' };
  }
  return { ok: true };
}

/** A trusted contact must be a mutual connection and carry a limited load. */
function checkTrustedContact({ borrowerId, contactId, isMutual, contactActiveCount }) {
  if (!contactId || contactId === borrowerId) return { ok: false, reason: 'Choose a trusted contact' };
  if (!isMutual) return { ok: false, reason: 'Your trusted contact must be someone you follow who follows you back' };
  if (contactActiveCount >= MAX_ACTIVE_AS_CONTACT) {
    return { ok: false, reason: `This person is already the trusted contact on ${MAX_ACTIVE_AS_CONTACT} requests` };
  }
  return { ok: true };
}

/** Validate a verifier's decision. A reason is required to reject. Returns { errors, value }. */
function validateVerification({ decision, reason } = {}) {
  const errors = {};
  const value = {};
  if (decision !== 'approve' && decision !== 'reject') {
    errors.decision = 'Decision must be approve or reject';
    return { errors, value };
  }
  value.decision = decision;
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (decision === 'reject') {
    if (text.length < REASON_MIN_LENGTH || text.length > REASON_MAX_LENGTH) {
      errors.reason = `Give a reason of ${REASON_MIN_LENGTH} to ${REASON_MAX_LENGTH} characters`;
    } else {
      value.reason = text;
    }
  } else if (text) {
    value.reason = text.slice(0, REASON_MAX_LENGTH);
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
function canVerify({ verifier, borrowerId, trustedContactId, status }) {
  if (!verifier?.isVerifier) return { ok: false, reason: 'Only verification team members can verify' };
  if (verifier.id === borrowerId || verifier.id === trustedContactId) {
    return { ok: false, reason: 'You cannot verify your own request' };
  }
  if (status !== 'pending_verification') {
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
  if (request.status === 'funded' && todayIst(now) > request.repaymentDate) return 'overdue';
  return request.status;
}

module.exports = {
  PURPOSE_MIN_LENGTH,
  PURPOSE_MAX_LENGTH,
  AMOUNT_MIN_PAISE,
  AMOUNT_MAX_PAISE,
  CATEGORIES,
  ACTIVE_STATUSES,
  MAX_ACTIVE_AS_CONTACT,
  DEFAULT_REQUIRED_APPROVALS,
  isIsoDate,
  todayIst,
  addMonths,
  daysOverdue,
  validateRequest,
  checkCanCreateRequest,
  checkTrustedContact,
  validateVerification,
  verificationOutcome,
  canVerify,
  checkContribution,
  effectiveStatus,
};
