const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestCard } = require('../public/app/card-model.js');

const BORROWER = 'u-borrower';
const NOMINEE = 'u-nominee';
const VERIFIER = 'u-verifier';
const MEMBER = 'u-member';

function request(overrides = {}) {
  return {
    id: 'r-1',
    borrowerId: BORROWER,
    nomineeId: NOMINEE,
    purpose: 'Repair the family van',
    principalCents: 50000,
    repaymentDate: '2026-12-31',
    status: 'open',
    raisedCents: 10000,
    amountDueCents: 0,
    daysOverdue: 0,
    ...overrides,
  };
}

function ids(card) {
  return card.actions.map((a) => a.id);
}

test('a borrower sees no verify or contribute actions on their own request', () => {
  const pending = requestCard(request({ status: 'pending_verification' }), { id: BORROWER, isVerifier: true });
  assert.equal(pending.role, 'borrower');
  assert.ok(!ids(pending).includes('verify-approve'));
  assert.ok(!ids(pending).includes('verify-reject'));

  const open = requestCard(request({ status: 'open' }), { id: BORROWER, isVerifier: false });
  assert.equal(open.role, 'borrower');
  assert.ok(!ids(open).includes('contribute'));
});

test('a nominee sees no verify action on the request they are named on', () => {
  const card = requestCard(request({ status: 'pending_verification' }), { id: NOMINEE, isVerifier: true });
  assert.equal(card.role, 'nominee');
  assert.ok(!ids(card).includes('verify-approve'));
  assert.ok(!ids(card).includes('verify-reject'));
});

test('a verifier who is neither borrower nor nominee sees verify actions while pending', () => {
  const card = requestCard(request({ status: 'pending_verification' }), { id: VERIFIER, isVerifier: true });
  assert.equal(card.role, 'verifier');
  assert.ok(ids(card).includes('verify-approve'));
  assert.ok(ids(card).includes('verify-reject'));
});

test('a verifier sees no verify action once the request is no longer pending', () => {
  for (const status of ['open', 'funded', 'overdue', 'repaid', 'rejected']) {
    const card = requestCard(request({ status }), { id: VERIFIER, isVerifier: true });
    assert.ok(!ids(card).includes('verify-approve'), `verify-approve on ${status}`);
    assert.ok(!ids(card).includes('verify-reject'), `verify-reject on ${status}`);
  }
});

test('a member sees contribute only on an open request they did not create', () => {
  const open = requestCard(request({ status: 'open' }), { id: MEMBER, isVerifier: false });
  assert.equal(open.role, 'member');
  assert.ok(ids(open).includes('contribute'));

  for (const status of ['pending_verification', 'funded', 'overdue', 'repaid', 'rejected']) {
    const card = requestCard(request({ status }), { id: MEMBER, isVerifier: false });
    assert.ok(!ids(card).includes('contribute'), `contribute on ${status}`);
  }
});

test('a repaid request offers no write actions to anyone', () => {
  const writeIds = ['verify-approve', 'verify-reject', 'contribute', 'repay'];
  const viewers = [
    { id: BORROWER, isVerifier: false },
    { id: NOMINEE, isVerifier: false },
    { id: VERIFIER, isVerifier: true },
    { id: MEMBER, isVerifier: false },
  ];
  for (const viewer of viewers) {
    const card = requestCard(request({ status: 'repaid' }), viewer);
    for (const id of writeIds) {
      assert.ok(!ids(card).includes(id), `${id} for ${viewer.id} on repaid`);
    }
  }
});

test('the nominee sees repay only on a funded or overdue request', () => {
  for (const status of ['funded', 'overdue']) {
    const card = requestCard(request({ status }), { id: NOMINEE, isVerifier: false });
    assert.equal(card.role, 'nominee');
    assert.ok(ids(card).includes('repay'), `repay on ${status}`);
  }
  for (const status of ['pending_verification', 'open', 'rejected', 'repaid']) {
    const card = requestCard(request({ status }), { id: NOMINEE, isVerifier: false });
    assert.ok(!ids(card).includes('repay'), `repay on ${status}`);
  }
  const stranger = requestCard(request({ status: 'funded' }), { id: MEMBER, isVerifier: false });
  assert.ok(!ids(stranger).includes('repay'), 'repay offered to a member');
});

test('progress is capped at 100 and is 0 for a zero principal', () => {
  const over = requestCard(request({ principalCents: 10000, raisedCents: 25000 }), { id: MEMBER });
  assert.equal(over.progressPct, 100);

  const half = requestCard(request({ principalCents: 10000, raisedCents: 5000 }), { id: MEMBER });
  assert.equal(half.progressPct, 50);

  const zero = requestCard(request({ principalCents: 0, raisedCents: 5000 }), { id: MEMBER });
  assert.equal(zero.progressPct, 0);
  assert.equal(zero.raisedLabel, '$50.00 of $0.00 raised');
});

test('status labels and tones match the lifecycle', () => {
  const expected = {
    pending_verification: ['Awaiting verification', 'warn'],
    rejected: ['Rejected', 'danger'],
    open: ['Open for funding', 'neutral'],
    funded: ['Funded', 'ok'],
    overdue: ['Overdue', 'danger'],
    repaid: ['Repaid', 'ok'],
  };
  for (const [status, [label, tone]] of Object.entries(expected)) {
    const card = requestCard(request({ status }), { id: MEMBER });
    assert.equal(card.statusLabel, label, `label for ${status}`);
    assert.equal(card.tone, tone, `tone for ${status}`);
  }
});
