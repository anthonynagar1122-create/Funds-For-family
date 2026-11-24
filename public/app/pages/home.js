(() => {
  'use strict';
  const esc = window.Format.esc;
  const inr = (c) => window.Money.formatInr(c);

  // Wording is plain and never relies on colour alone.
  const STATUS = {
    awaiting_contact: 'Waiting for trusted contact', contact_declined: 'Trusted contact declined', withdrawn: 'Withdrawn', closed: 'Closed',
    pending_verification: 'Awaiting verification', rejected: 'Rejected', open: 'Open for funding', funded: 'Funded', overdue: 'Overdue', repaid: 'Repaid',
  };
  const statusBadge = (s) => `<span class="badge">${esc(STATUS[s] ?? s)}</span>`;

  function needText(n) {
    const who = n.otherName ? esc(n.otherName) : 'a member';
    const amt = typeof n.amountCents === 'number' ? ` ${esc(inr(n.amountCents))}` : '';
    switch (n.kind) {
      case 'confirm_contribution': return { title: `Confirm${amt} received from ${who}`, cta: 'Review' };
      case 'confirm_repayment': return { title: `Confirm${amt} repaid by ${who}`, cta: 'Review' };
      case 'fix_contribution': return { title: `${who} says${amt} has not arrived`, cta: 'Fix' };
      case 'fix_repayment': return { title: `${who} says your${amt} repayment has not arrived`, cta: 'Fix' };
      case 'contact_decision': return { title: `${who} asked you to be their trusted contact`, cta: 'Decide' };
      case 'verify': return { title: n.otherName ? `Verify a request from ${who}` : 'Verify a request', cta: 'Verify' };
      case 'repick_contact': return { title: `${who} declined. Choose another trusted contact`, cta: 'Choose' };
      default: return { title: 'Needs your attention', cta: 'Open' };
    }
  }

  function requestCard(r) {
    const confirmed = r.totals?.confirmedCents ?? 0;
    const pending = r.totals?.pendingCents ?? 0;
    const pct = r.principalCents > 0 ? Math.min(100, Math.floor((confirmed * 100) / r.principalCents)) : 0;
    return `<li class="card">
      <p class="card-title"><a class="home-link" href="#/request/${esc(r.id)}">${esc(r.purpose)}</a></p>
      <div class="meta">${statusBadge(r.status)}<span>Asked for ${esc(inr(r.principalCents))}</span></div>
      <div class="progress" role="progressbar" aria-label="Confirmed so far" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      <p class="muted">${esc(inr(confirmed))} confirmed, ${esc(inr(pending))} waiting for confirmation (${pct}% confirmed)</p>
    </li>`;
  }

  function lendingCard(r) {
    return `<li class="card">
      <p class="card-title"><a class="home-link" href="#/request/${esc(r.id)}">${esc(r.purpose)}</a></p>
      <div class="meta">${statusBadge(r.status)}</div>
      <p>${esc(inr(r.myOwedCents))} still owed to you</p>
      <p class="muted">You lent ${esc(inr(r.myLentCents))}, repaid so far ${esc(inr(r.myRepaidCents))}</p>
    </li>`;
  }

  async function render(root) {
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    const data = await window.Api.get('/home');
    const needs = data.needsYou || [];
    const mine = data.myRequests || [];
    const lending = data.myLending || [];
    if (needs.length + mine.length + lending.length === 0) {
      root.innerHTML = `<h1 id="home-title" tabindex="-1">Home</h1>
        <div class="panel" id="home-empty">
          <h2>Nothing here yet</h2>
          <p>Ask for help with something real, or bring in someone you trust.</p>
          <p class="row-actions"><a class="btn btn-primary" href="#/new">Start a request</a> <a class="btn btn-ghost" href="#/circle">Invite someone you trust</a></p>
        </div>`;
      return;
    }
    const needsHtml = needs.length
      ? `<ul class="cards" id="needs-list">${needs.map((n) => {
        const t = needText(n);
        return `<li class="card" data-kind="${esc(n.kind)}"><p class="card-title"><a class="home-link" href="#/request/${esc(n.requestId)}">${t.title}</a></p>
          <p class="row-actions"><a class="btn btn-sm btn-primary" href="#/request/${esc(n.requestId)}">${esc(t.cta)}</a></p></li>`;
      }).join('')}</ul>`
      : '<p class="empty" id="needs-empty">Nothing needs you right now.</p>';
    root.innerHTML = `<h1 id="home-title" tabindex="-1">Home</h1>
      <section aria-labelledby="needs-title"><h2 id="needs-title">Needs you (<span id="needs-count">${needs.length}</span>)</h2>${needsHtml}</section>
      <section aria-labelledby="mine-title"><h2 id="mine-title">My requests</h2>${mine.length ? `<ul class="cards" id="my-requests">${mine.map(requestCard).join('')}</ul>` : '<p class="empty">You have no requests.</p>'}</section>
      <section aria-labelledby="lend-title"><h2 id="lend-title">My lending</h2>${lending.length ? `<ul class="cards" id="my-lending">${lending.map(lendingCard).join('')}</ul>` : '<p class="empty">You have not lent anything.</p>'}</section>`;
  }

  window.HomePage = { render, needText };
})();
