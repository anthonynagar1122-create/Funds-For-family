(function () {
  'use strict';

  const STATUS = {
    awaiting_contact: { label: 'Waiting for trusted contact', tone: 'warn' },
    contact_declined: { label: 'Trusted contact declined', tone: 'danger' },
    pending_verification: { label: 'Awaiting verification', tone: 'warn' },
    rejected: { label: 'Rejected', tone: 'danger' },
    open: { label: 'Open for funding', tone: 'neutral' },
    funded: { label: 'Funded', tone: 'ok' },
    overdue: { label: 'Overdue', tone: 'danger' },
    repaid: { label: 'Repaid', tone: 'ok' },
    withdrawn: { label: 'Withdrawn', tone: 'neutral' },
    closed: { label: 'Closed', tone: 'neutral' },
  };

  const Money =
    typeof module !== 'undefined' && module.exports ? require('./money.js') : window.Money;

  function formatCents(cents) {
    return Money.formatInr(cents);
  }

  function deriveRole(request, viewer) {
    if (viewer.id === request.borrowerId) return 'borrower';
    if (viewer.id === request.trustedContactId) return 'trustedContact';
    if (viewer.isVerifier) return 'verifier';
    return 'member';
  }

  function deriveActions(request, viewer, role) {
    const actions = [];
    const status = request.status;

    if (role === 'trustedContact' && status === 'awaiting_contact') {
      actions.push({ id: 'contact-accept', label: 'Accept', tone: 'primary' });
      actions.push({ id: 'contact-decline', label: 'Decline', tone: 'danger' });
    }

    const decided = (request.verifications || []).some((v) => v.verifierId === viewer.id);
    if (role === 'verifier' && status === 'pending_verification' && !decided) {
      actions.push({ id: 'verify-approve', label: 'Approve', tone: 'ok' });
      actions.push({ id: 'verify-reject', label: 'Reject', tone: 'danger' });
    }

    if (role !== 'borrower' && status === 'open') {
      actions.push({ id: 'contribute', label: 'Contribute', tone: 'primary' });
    }

    // The borrower and the trusted contact may record repayments.
    if ((role === 'trustedContact' || role === 'borrower') && (status === 'funded' || status === 'overdue')) {
      actions.push({ id: 'repay', label: 'Record repayment', tone: 'primary' });
    }

    actions.push({ id: 'view', label: 'View', tone: 'neutral' });
    return actions;
  }

  function requestCard(request, viewer) {
    const status = STATUS[request.status] || { label: request.status, tone: 'neutral' };
    const principal = request.principalCents;
    const raised = (request.totals && request.totals.confirmedCents) || 0;
    const progressPct =
      principal > 0 ? Math.min(100, Math.floor((raised * 100) / principal)) : 0;
    const role = deriveRole(request, viewer);

    return {
      title: request.purpose,
      statusLabel: status.label,
      tone: status.tone,
      progressPct,
      raisedLabel: formatCents(raised) + ' of ' + formatCents(principal) + ' raised',
      dueLabel:
        request.status === 'overdue'
          ? request.daysOverdue + ' days overdue'
          : 'Due ' + request.repaymentDate,
      role,
      actions: deriveActions(request, viewer, role),
    };
  }

  // Borrower-only controls on the request page. They mirror the API rules (withdraw, close, trusted-contact), so
  // the page only offers what the server will accept. The server stays authoritative.
  const WITHDRAWABLE = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open'];
  function ownerActions(request, viewer) {
    if (!request || !viewer || viewer.id !== request.borrowerId) return [];
    const confirmed = (request.totals && request.totals.confirmedCents) || 0;
    const out = [];
    if (WITHDRAWABLE.includes(request.status) && confirmed === 0) out.push({ id: 'withdraw', label: 'Withdraw request' });
    if (request.status === 'open' && confirmed > 0) out.push({ id: 'close', label: 'Close with ' + formatCents(confirmed), confirmedCents: confirmed });
    if (request.status === 'contact_declined') out.push({ id: 'repick-contact', label: 'Choose another trusted contact' });
    if (request.status === 'rejected') out.push({ id: 'try-again', label: 'Try again' });
    return out;
  }

  const api = { requestCard, ownerActions };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.CardModel = api;
  }
})();
