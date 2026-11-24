'use strict';
// Pure business rules. No I/O: safe to unit-test and to reuse on server and client.

const { parseRupees, formatInr } = require('../public/app/money');

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

const ENTRY_STATUSES = ['sent', 'confirmed', 'not_received'];
const UTR_RE = /^[A-Za-z0-9]{6,35}$/;

/** A UTR is optional; when present it must be 6-35 alphanumerics. */
function validateUtr(s) {
  if (s === undefined || s === null || s === '') return true;
  return typeof s === 'string' && UTR_RE.test(s);
}

/** Money lent so far: confirmed counts as raised, sent as pending. not_received is ignored. */
function fundingTotals(contributions) {
  let confirmedCents = 0;
  let pendingCents = 0;
  for (const c of contributions) {
    if (c.status === 'confirmed') confirmedCents += c.amountCents;
    else if (c.status === 'sent') pendingCents += c.amountCents;
  }
  return { confirmedCents, pendingCents };
}

/** Contribution cap. Returns { ok, reason?, remainingCents }. */
function checkContribution({ amountCents, principalCents, totals, contributorId, borrowerId, isMutual: mutual, status }) {
  const remainingCents = Math.max(0, principalCents - totals.confirmedCents - totals.pendingCents);
  if (contributorId === borrowerId) return { ok: false, reason: 'You cannot fund your own request', remainingCents };
  if (!mutual) return { ok: false, reason: 'Only mutual connections can fund this request', remainingCents };
  if (status !== 'open') return { ok: false, reason: 'This request is not accepting contributions', remainingCents };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'Contribution must be a positive amount', remainingCents };
  }
  if (amountCents > remainingCents) {
    return { ok: false, reason: `Only ${formatInr(remainingCents)} is still needed`, remainingCents };
  }
  return { ok: true, remainingCents };
}

/**
 * After a write, whether the row `rowId` pushes the running total over the cap. Entries are taken in id order
 * (first come, first served); only sent and confirmed amounts count, not_received is ignored. False if rowId is absent.
 */
function exceedsCapAtRow(entries, rowId, capCents) {
  let running = 0;
  for (const e of [...entries].sort((a, b) => a.id - b.id)) {
    if (e.status === 'sent' || e.status === 'confirmed') running += e.amountCents;
    if (e.id === rowId) return e.status !== 'not_received' && running > capCents;
  }
  return false;
}

/** Per-lender position. Lent and repaid count confirmed rows only; pendingRepay counts sent repayments. */
function owedByLender(contributions, repayments) {
  const map = new Map();
  const entry = (id) => {
    if (!map.has(id)) map.set(id, { lentCents: 0, repaidCents: 0, pendingRepayCents: 0, owedCents: 0 });
    return map.get(id);
  };
  const known = (id) => id !== null && id !== undefined;  // old repayments may have no lender_id: they belong to nobody
  for (const c of contributions) {
    if (known(c.lenderId) && c.status === 'confirmed') entry(c.lenderId).lentCents += c.amountCents;
  }
  for (const p of repayments) {
    if (!known(p.lenderId)) continue;
    if (p.status === 'confirmed') entry(p.lenderId).repaidCents += p.amountCents;
    else if (p.status === 'sent') entry(p.lenderId).pendingRepayCents += p.amountCents;
  }
  for (const e of map.values()) e.owedCents = e.lentCents - e.repaidCents;
  return map;
}

/** A repayment to one lender. Returns { ok, reason? }. */
function checkRepayment({ amountCents, payerId, borrowerId, trustedContactId, lenderId, owed, status }) {
  if (status !== 'funded') return { ok: false, reason: 'This request is not in repayment' };
  if (payerId !== borrowerId && payerId !== trustedContactId) {
    return { ok: false, reason: 'Only the borrower or trusted contact can record a repayment' };
  }
  if (lenderId === undefined || lenderId === null || !owed) return { ok: false, reason: 'Unknown lender' };
  if (payerId === lenderId) return { ok: false, reason: 'You cannot repay yourself' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'Repayment must be a positive amount' };
  }
  const room = owed.owedCents - owed.pendingRepayCents;
  if (amountCents > room) return { ok: false, reason: `Only ${formatInr(Math.max(0, room))} can still be repaid to this lender` };
  return { ok: true };
}

/** Every lender fully repaid (nothing owed, or over-repaid), and there is at least one lender. */
function isFullyRepaid(owedMap) {
  if (!owedMap || owedMap.size === 0) return false;
  for (const e of owedMap.values()) if (e.owedCents > 0) return false;
  return true;
}

/** Mutual = each follows the other. Accepts arrays or Sets of ids. */
function isMutual({ following, followers }, otherId) {
  const has = (c) => (c instanceof Set ? c.has(otherId) : Array.isArray(c) && c.includes(otherId));
  return has(following) && has(followers);
}

/** Who may read a request (callers return 404 when false). */
function canSeeRequest({ viewerId, request, isMutualWithBorrower, isLender, viewerIsVerifier }) {
  if (viewerId === request.borrowerId || viewerId === request.trustedContactId) return true;
  if (isLender) return true;
  if (viewerIsVerifier && request.status === 'pending_verification') return true;
  if (isMutualWithBorrower && ['open', 'funded', 'repaid'].includes(request.status)) return true;
  return false;
}

/**
 * Spec 5.6: whether the viewer sees ownerId's UPI ID on this request.
 * Owner always. Borrower's UPI: its lenders, and mutuals while open.
 * A lender's UPI: the borrower and trusted contact.
 */
function paymentTargetVisible({ viewerId, ownerId, request, lenderIds = [], isMutualWithOwner = false }) {
  if (viewerId === ownerId) return true;
  if (ownerId === request.borrowerId) {
    if (lenderIds.includes(viewerId)) return true;
    return Boolean(isMutualWithOwner) && request.status === 'open';
  }
  if (lenderIds.includes(ownerId)) {
    return viewerId === request.borrowerId || viewerId === request.trustedContactId;
  }
  return false;
}

/** Stored status plus derived 'overdue'. */
function effectiveStatus(request, now) {
  if (request.status === 'funded' && todayIst(now) > request.repaymentDate) return 'overdue';
  return request.status;
}

/**
 * Why a member cannot delete their account yet, or null. Money is never forgotten: an active request, money owed to
 * the member as a lender, or any entry on their side still waiting to be settled all block deletion.
 */
function deletionBlock({ activeCount = 0, owedToMeCents = 0, unsettledCount = 0 } = {}) {
  if (activeCount > 0) return 'You have a request that is still active. Finish or withdraw it before deleting your account.';
  if (owedToMeCents > 0) return 'You are still owed money from a loan. Wait until it is repaid before deleting your account.';
  if (unsettledCount > 0) return 'Some payments are still waiting to be confirmed. Money is owed one way or the other until they are settled, so deleting your account has to wait.';
  return null;
}

/**
 * Trust history: facts only, computed from the ledger and never stored. No overdue or unpaid counts exist here on purpose.
 * repaidRequests are the member's own requests with status repaid; lentToCount is how many requests they lent to.
 */
function trustFacts({ createdAt, repaidRequests = [], lentToCount = 0 }) {
  const onTime = repaidRequests.filter((r) => r.repaidAt && r.repaymentDate && todayIst(new Date(r.repaidAt)) <= r.repaymentDate).length;
  return { memberSince: createdAt ?? null, repaidCount: repaidRequests.length, repaidOnTimeCount: onTime, lentToCount };
}

module.exports = {
  deletionBlock,
  trustFacts,
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
  ENTRY_STATUSES,
  validateUtr,
  fundingTotals,
  checkContribution,
  owedByLender,
  checkRepayment,
  exceedsCapAtRow,
  isFullyRepaid,
  isMutual,
  canSeeRequest,
  paymentTargetVisible,
  effectiveStatus,
};
