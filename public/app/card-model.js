(function () {
  'use strict';

  const STATUS = {
    pending_verification: { label: 'Awaiting verification', tone: 'warn' },
    rejected: { label: 'Rejected', tone: 'danger' },
    open: { label: 'Open for funding', tone: 'neutral' },
    funded: { label: 'Funded', tone: 'ok' },
    overdue: { label: 'Overdue', tone: 'danger' },
    repaid: { label: 'Repaid', tone: 'ok' },
  };

  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function deriveRole(request, viewer) {
    if (viewer.id === request.borrowerId) return 'borrower';
    if (viewer.id === request.nomineeId) return 'nominee';
    if (viewer.isVerifier) return 'verifier';
    return 'member';
  }

  function deriveActions(request, viewer, role) {
    const actions = [];
    const status = request.status;

    const decided = (request.verifications || []).some((v) => v.verifierId === viewer.id);
    if (role === 'verifier' && status === 'pending_verification' && !decided) {
      actions.push({ id: 'verify-approve', label: 'Approve', tone: 'ok' });
      actions.push({ id: 'verify-reject', label: 'Reject', tone: 'danger' });
    }

    if (role !== 'borrower' && status === 'open') {
      actions.push({ id: 'contribute', label: 'Contribute', tone: 'primary' });
    }

    // The borrower and the nominee may both record repayments (constraint: only they may).
    if ((role === 'nominee' || role === 'borrower') && (status === 'funded' || status === 'overdue')) {
      actions.push({ id: 'repay', label: 'Record repayment', tone: 'primary' });
    }

    actions.push({ id: 'view', label: 'View', tone: 'neutral' });
    return actions;
  }

  function requestCard(request, viewer) {
    const status = STATUS[request.status] || { label: request.status, tone: 'neutral' };
    const principal = request.principalCents;
    const raised = request.raisedCents;
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

  const api = { requestCard };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.CardModel = api;
  }
})();
