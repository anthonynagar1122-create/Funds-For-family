(() => {
  'use strict';
  const esc = window.Format.esc;
  const money = (c) => window.Money.formatInr(c);
  const UTR_RE = /^[A-Za-z0-9]{6,35}$/;
  const newIdempotencyKey = () => window.crypto?.randomUUID?.() || `ff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const UTR_MSG = 'A UPI reference is 6 to 35 letters or digits';

  const STATUS = {
    awaiting_contact: ['badge-warn', 'Waiting for trusted contact'], contact_declined: ['badge-danger', 'Trusted contact declined'],
    withdrawn: ['', 'Withdrawn'], closed: ['', 'Closed'], pending_verification: ['badge-warn', 'Awaiting verification'], rejected: ['badge-danger', 'Rejected'],
    open: ['', 'Open for funding'], funded: ['badge-ok', 'Funded'], overdue: ['badge-danger', 'Overdue'], repaid: ['badge-ok', 'Repaid'],
  };
  const statusBadge = (s) => { const [cls, label] = STATUS[s] ?? ['', s]; return `<span class="badge ${cls}">${esc(label)}</span>`; };

  const rupees = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  const day = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const waLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

  // The UPI deep link. It is only ever built from a payTo entry the API returned.
  function upiHref(target, cents, requestId) {
    const q = [
      ['pa', encodeURIComponent(target.upiId).replace(/%40/g, '@')],
      ['pn', encodeURIComponent(target.name)],
      ['am', rupees(cents)],
      ['cu', 'INR'],
      ['tn', encodeURIComponent(`Funds For Family request ${requestId}`)],
    ];
    return `upi://pay?${q.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return null;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch { return null; }
  }

  // Pay block: a button on phones, a QR code on wide screens (CSS picks one), or an ask-for-their-UPI prompt.
  function payBlock(target, payee, cents, requestId) {
    if (!target) {
      const text = `Hi ${payee.name}, please add your UPI ID on Funds For Family so I can pay you for request ${requestId}.`;
      return `<div class="pay-box"><p class="muted">${esc(payee.name)} has not added a UPI ID yet.</p>
        <a class="btn btn-secondary" href="${esc(waLink(text))}" target="_blank" rel="noopener noreferrer">Ask ${esc(payee.name)} to add their UPI ID</a></div>`;
    }
    const href = upiHref(target, cents, requestId);
    const svg = qrSvg(href);
    return `<div class="pay-box"><p>Pay ${esc(target.name)}: <strong>${esc(target.upiId)}</strong></p>
      <a class="btn btn-primary upi-pay upi-link" href="${esc(href)}">Pay ${esc(money(cents))} with UPI</a>
      <div class="upi-qr">${svg ? `<div class="qr-img" role="img" aria-label="${esc(`QR code to pay ${money(cents)} to ${target.name}`)}">${svg}</div><p class="muted">Scan with any UPI app to pay ${esc(money(cents))}.</p>`
        : `<p class="muted">Copy this into your UPI app:</p><input class="copy-box" readonly value="${esc(href)}" aria-label="UPI payment string">`}</div></div>`;
  }

  function timelineEvents(r, name) {
    const ev = [];
    for (const c of r.contributions || []) {
      if (c.createdAt) ev.push({ at: c.createdAt, text: `${name(c.contributorId)} said they sent ${money(c.amountCents)}${c.status === 'not_received' ? ' (marked not received)' : ''}` });
      if (c.confirmedAt) ev.push({ at: c.confirmedAt, text: `${money(c.amountCents)} from ${name(c.contributorId)} was confirmed` });
    }
    for (const p of r.repayments || []) {
      if (p.createdAt) ev.push({ at: p.createdAt, text: `${name(p.payerId)} repaid ${money(p.amountCents)} to ${name(p.lenderId)}${p.status === 'not_received' ? ' (marked not received)' : ''}` });
      if (p.confirmedAt) ev.push({ at: p.confirmedAt, text: `Repayment of ${money(p.amountCents)} to ${name(p.lenderId)} was confirmed` });
    }
    ev.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return ev;
  }

  async function render(root, { id, me, userName, toast, rerender, entry }) {
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    let r;
    try { ({ request: r } = await window.Api.get(`/requests/${id}`)); }
    catch (err) {
      if (err.status === 404 || err.status === 403) {
        root.innerHTML = `<p><a href="#/home">← Back to home</a></p><h1 id="detail-title" tabindex="-1">This request is not available to you</h1>
          <p class="muted">It may not exist, or it may belong to someone outside your circle.</p>`;
      } else {
        root.innerHTML = `<p><a href="#/home">← Back to home</a></p><h1 id="detail-title" tabindex="-1">Could not load this request</h1><p class="error" role="alert">${esc(err.message)}</p>`;
      }
      return;
    }
    const confirmed = r.totals?.confirmedCents ?? 0;
    const pending = r.totals?.pendingCents ?? 0;
    const pct = r.principalCents > 0 ? Math.min(100, Math.floor((confirmed * 100) / r.principalCents)) : 0;
    const pendPct = r.principalCents > 0 ? Math.min(100 - pct, Math.floor((pending * 100) / r.principalCents)) : 0;
    const lenders = r.lenders || [];
    const contributions = r.contributions || [];
    const repayments = r.repayments || [];
    const ids = new Set([r.borrowerId, r.trustedContactId, ...lenders.map((l) => l.userId), ...contributions.map((c) => c.contributorId), ...repayments.flatMap((p) => [p.payerId, p.lenderId]), ...(r.verifications || []).map((v) => v.verifierId)]);
    const names = new Map(await Promise.all([...ids].filter((u) => u !== null && u !== undefined).map(async (uid) => [uid, await userName(uid)])));
    const name = (uid) => names.get(uid) ?? 'Member';
    // Every role-based decision comes from the card model, so the page and the cards cannot disagree.
    const card = window.CardModel.requestCard(r, me);
    const can = (aid) => card.actions.some((a) => a.id === aid);
    const isBorrower = me.id === r.borrowerId;
    const isContact = me.id === r.trustedContactId;
    const repayable = can('repay');
    const payTo = r.payTo || [];
    const payFor = (uid) => payTo.find((t) => t.userId === uid) || null;
    const utr = (x) => (x.utr ? ` · UTR ${esc(x.utr)}` : '');

    // Fix and Delete for the sender of an entry the receiver marked "not received" (G-03). The edit form opens in place.
    const fixControls = (kind, e) => `<span class="row-actions">
          <button class="btn btn-sm btn-primary" type="button" data-fix="edit" data-kind="${kind}" data-entry="${esc(e.id)}">Fix</button>
          <button class="btn btn-sm btn-ghost" type="button" data-fix="delete" data-kind="${kind}" data-entry="${esc(e.id)}">Delete</button></span>
        <div class="fix-slot" data-slot="${kind}-${esc(e.id)}"></div>`;
    const contributionRow = (c) => `<li id="contribution-${esc(c.id)}" tabindex="-1">${esc(name(c.contributorId))} · ${money(c.amountCents)} · ${esc(c.status)}${utr(c)}
        ${isBorrower && c.status === 'sent' ? `<span class="row-actions">
          <button class="btn btn-sm btn-primary" type="button" data-confirm-contribution="${esc(c.id)}">Confirm</button>
          <button class="btn btn-sm btn-ghost" type="button" data-notreceived-contribution="${esc(c.id)}">Not received</button></span>` : ''}
        ${me.id === c.contributorId && c.status === 'not_received' ? fixControls('contribution', c) : ''}</li>`;
    const repaymentRow = (p) => `<li id="repayment-${esc(p.id)}" tabindex="-1">${esc(name(p.payerId))} to ${esc(name(p.lenderId))} · ${money(p.amountCents)} · ${esc(p.status)}${utr(p)}
        ${me.id === p.lenderId && p.status === 'sent' ? `<span class="row-actions">
          <button class="btn btn-sm btn-primary" type="button" data-confirm-repayment="${esc(p.id)}">Confirm</button>
          <button class="btn btn-sm btn-ghost" type="button" data-notreceived-repayment="${esc(p.id)}">Not received</button></span>` : ''}
        ${me.id === p.payerId && p.status === 'not_received' ? fixControls('repayment', p) : ''}</li>`;
    const lenderRow = (l) => `<li class="lender-row"><strong>${esc(name(l.userId))}</strong>
        <span class="muted">lent ${money(l.lentCents)} · repaid ${money(l.repaidCents)}${l.pendingRepayCents > 0 ? ` · ${money(l.pendingRepayCents)} awaiting confirmation` : ''} · still owed ${money(l.owedCents)}</span>
        ${repayable && l.owedCents > 0 ? `<form class="repay-form form" data-lender="${esc(l.userId)}" novalidate>
          <div class="repay-pay" data-owed="${esc(l.owedCents)}"></div>
          <label for="p-amount-${esc(l.userId)}">Amount you repaid ${esc(name(l.userId))} (₹)</label>
          <input id="p-amount-${esc(l.userId)}" name="amount" type="text" inputmode="decimal" autocomplete="off" required>
          <label for="p-utr-${esc(l.userId)}">UTR (optional)</label>
          <input id="p-utr-${esc(l.userId)}" name="utr" type="text" autocomplete="off">
          <p class="error" role="alert"></p>
          <button class="btn btn-primary" type="submit">Record repayment</button></form>` : ''}</li>`;

    // Borrower controls (withdraw, close early, another contact, Try again), gated by the card model.
    const ownerActs = window.CardModel.ownerActions(r, me);
    const ownerHas = (aid) => ownerActs.find((a) => a.id === aid);
    const ownerHtml = ownerActs.length ? `<section class="panel owner-actions" aria-labelledby="owner-title"><h2 id="owner-title">Manage your request</h2>
        ${ownerHas('repick-contact') ? `<div class="field"><label for="repick-contact">Choose another trusted contact</label>
          <select id="repick-contact"><option value="">Loading…</option></select>
          <p class="hint">${esc(name(r.trustedContactId))} declined. Pick someone you are mutually connected with.</p>
          <button class="btn btn-primary" type="button" id="repick-send">Send to this contact</button></div>` : ''}
        <div class="row-actions">
          ${ownerHas('withdraw') ? '<button class="btn btn-secondary" type="button" data-owner="withdraw">Withdraw request</button>' : ''}
          ${ownerHas('close') ? `<button class="btn btn-secondary" type="button" data-owner="close">${esc(ownerHas('close').label)}</button>` : ''}
          ${ownerHas('try-again') ? `<a class="btn btn-primary" href="#/new/${esc(r.id)}">Try again</a>` : ''}
        </div>
        <div id="owner-confirm" role="group" aria-label="Confirm"></div>
        <p class="error" id="owner-error" role="alert"></p></section>` : '';

    const events = timelineEvents(r, name);
    const decisions = (r.verifications || []).map((v) => `${name(v.verifierId)} ${v.decision === 'approve' ? 'approved' : 'rejected'} the purpose${v.note ? `: ${v.note}` : ''}`);
    const overdueText = `Reminder: the repayment for "${r.purpose}" (request ${r.id}, ${money(r.principalCents)}) was due on ${r.repaymentDate}. Please record it on Funds For Family.`;

    root.innerHTML = `
      <p><a href="#/home">← Back to home</a></p>
      <h1 id="detail-title" tabindex="-1">${esc(r.purpose)}</h1>
      <div class="meta">${statusBadge(r.status)}<span>Requested by ${esc(name(r.borrowerId))}</span><span>Trusted contact: ${esc(name(r.trustedContactId))}</span></div>
      <div class="meta"><span>Amount ${money(r.principalCents)}</span><span>Repay by ${esc(r.repaymentDate)}</span>
        ${r.daysOverdue > 0 ? `<span>${esc(r.daysOverdue)} days overdue</span>` : ''}</div>
      ${r.status === 'repaid' ? '<p id="repaid-banner" class="banner-quiet" role="status">This request has been repaid in full. Thank you.</p>' : ''}
      ${r.rejectionReason && isBorrower ? `<p class="error" id="rejection-reason">Reason given: ${esc(r.rejectionReason)}</p>` : ''}
      ${ownerHtml}
      ${['open', 'funded', 'overdue', 'repaid'].includes(r.status) ? `
        <div class="progress" role="progressbar" aria-label="Funding progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <span class="progress-confirmed" style="width:${pct}%"></span><span class="progress-pending" style="width:${pendPct}%"></span></div>
        <p class="muted">${money(confirmed)} confirmed · ${money(pending)} pending · of ${money(r.principalCents)}</p>` : ''}
      ${r.status === 'overdue' && (isBorrower || isContact) ? `<p><a class="btn btn-secondary wa-reminder" href="${esc(waLink(overdueText))}" target="_blank" rel="noopener noreferrer">Send a reminder on WhatsApp</a></p>` : ''}
      ${can('contact-accept') ? `
        <div class="row-actions" style="margin-top:16px">
          <button class="btn btn-primary" type="button" data-contact="accept">Accept</button>
          <button class="btn btn-secondary" type="button" data-contact="decline">Decline</button></div>` : ''}
      <h2>Verification</h2>
      <ul class="list">${(r.verifications || []).length ? r.verifications.map((v) => `<li>${v.decision === 'approve' ? 'Approved' : 'Rejected'}${v.note ? ': ' + esc(v.note) : ''}</li>`).join('') : '<li class="muted">No decisions yet. Two approvals are needed.</li>'}</ul>
      ${can('verify-approve') ? `
        <form id="verify-form" class="form" style="margin-top:16px">
          <div class="field"><label for="v-note">Note (optional)</label><textarea id="v-note" rows="2" maxlength="1000"></textarea></div>
          <div class="row-actions">
            <button class="btn btn-primary" name="decision" value="approve" type="submit">Approve purpose</button>
            <button class="btn btn-secondary" name="decision" value="reject" type="submit">Reject</button>
          </div>
        </form>` : ''}
      ${can('contribute') ? `
        <h2>Send the money by UPI</h2>
        <div id="pay-box-slot"></div>
        <form id="fund-form" class="form" style="margin-top:16px" novalidate>
          <div class="field"><label for="c-amount">Amount you sent (₹, up to ${money(r.remainingCents)})</label>
            <input id="c-amount" type="text" inputmode="decimal" autocomplete="off" required>
            <label for="c-utr">UTR (optional)</label>
            <input id="c-utr" type="text" autocomplete="off">
            <p class="error" id="e-fund" role="alert"></p></div>
          <button class="btn btn-primary" type="submit">I've sent it</button>
        </form>` : ''}
      ${lenders.length ? `<h2>Lenders</h2><ul class="list">${lenders.map(lenderRow).join('')}</ul>` : ''}
      ${contributions.length ? `<h2>Contributions</h2><ul class="list">${contributions.map(contributionRow).join('')}</ul>` : ''}
      ${repayments.length ? `<h2>Repayments</h2><ul class="list">${repayments.map(repaymentRow).join('')}</ul>` : ''}
      <h2>Timeline</h2>
      <ol class="list" id="timeline">${events.map((e) => `<li><span class="muted">${esc(day(e.at))}</span> ${esc(e.text)}</li>`).join('')}${decisions.map((t) => `<li>${esc(t)}</li>`).join('')}${events.length + decisions.length === 0 ? '<li class="muted">Nothing has happened yet.</li>' : ''}</ol>
      <p class="muted" style="margin-top:24px">Payments are recorded here for transparency. No money moves through this app. A payment counts once the person receiving it confirms.</p>`;

    const act = async (path, body, message) => {
      try { await window.Api.post(path, body ?? {}); toast(message); rerender(); }
      catch (err) { toast(err.message); }
    };
    root.querySelectorAll('[data-contact]').forEach((b) => b.addEventListener('click', () => act(`/requests/${id}/contact-decision`, { decision: b.dataset.contact }, 'Answer recorded')));
    root.querySelectorAll('[data-confirm-contribution]').forEach((b) => b.addEventListener('click', () => act(`/contributions/${b.dataset.confirmContribution}/confirm`, null, 'Contribution confirmed')));
    root.querySelectorAll('[data-notreceived-contribution]').forEach((b) => b.addEventListener('click', () => act(`/contributions/${b.dataset.notreceivedContribution}/not-received`, null, 'Marked as not received')));
    root.querySelectorAll('[data-confirm-repayment]').forEach((b) => b.addEventListener('click', () => act(`/repayments/${b.dataset.confirmRepayment}/confirm`, null, 'Repayment confirmed')));
    root.querySelectorAll('[data-notreceived-repayment]').forEach((b) => b.addEventListener('click', () => act(`/repayments/${b.dataset.notreceivedRepayment}/not-received`, null, 'Marked as not received')));

    // ---- Borrower controls ----
    const ownerErr = root.querySelector('#owner-error');
    const confirmBox = root.querySelector('#owner-confirm');
    // Runs one API call with the given buttons disabled; shows the server's text on failure.
    const guard = async (buttons, errEl, call, message) => {
      buttons.forEach((b) => { b.disabled = true; });
      if (errEl) errEl.textContent = '';
      try { await call(); toast(message); rerender(); }
      catch (e) { if (errEl) errEl.textContent = e.message; buttons.forEach((b) => { b.disabled = false; }); }
    };
    const askConfirm = (box, text, yesLabel, noLabel, onYes) => {
      box.innerHTML = '';
      const p = document.createElement('p'); p.textContent = text;
      const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn btn-primary'; yes.textContent = yesLabel;
      const no = document.createElement('button'); no.type = 'button'; no.className = 'btn btn-ghost'; no.textContent = noLabel;
      const row = document.createElement('div'); row.className = 'row-actions'; row.append(yes, no);
      box.append(p, row);
      no.addEventListener('click', () => { box.innerHTML = ''; });
      yes.addEventListener('click', () => onYes([yes, no]));
      yes.focus();
    };
    root.querySelectorAll('[data-owner]').forEach((b) => b.addEventListener('click', () => {
      ownerErr.textContent = '';
      if (b.dataset.owner === 'withdraw') {
        askConfirm(confirmBox, 'Withdraw this request? Anyone who said they sent money will be told.', 'Yes, withdraw it', 'Keep my request',
          (btns) => guard(btns, ownerErr, () => window.Api.post(`/requests/${id}/withdraw`, {}), 'Request withdrawn'));
      } else {
        const amt = money(confirmed);
        askConfirm(confirmBox, `Close this request with ${amt}? No more money can be added. You will repay what was lent.`, 'Yes, close it', 'Keep it open',
          (btns) => guard(btns, ownerErr, () => window.Api.post(`/requests/${id}/close`, {}), `Closed with ${amt}`));
      }
    }));
    const repick = root.querySelector('#repick-contact');
    if (repick) {
      const send = root.querySelector('#repick-send');
      window.Api.get('/users').then(({ users }) => {
        const pick = (users || []).filter((u) => u.id !== r.trustedContactId);
        repick.innerHTML = '<option value="">Choose a trusted contact</option>';
        for (const u of pick) { const o = document.createElement('option'); o.value = String(u.id); o.textContent = u.name; repick.append(o); }
        if (!pick.length) ownerErr.textContent = 'You have no other mutual connections yet. Connect with someone in Circle first.';
      }).catch((e) => { repick.innerHTML = '<option value="">Choose a trusted contact</option>'; ownerErr.textContent = e.message; });
      send.addEventListener('click', () => {
        if (!repick.value) { ownerErr.textContent = 'Choose a trusted contact'; repick.focus(); return; }
        guard([send, repick], ownerErr, () => window.Api.post(`/requests/${id}/trusted-contact`, { userId: Number(repick.value) }), 'Sent to your new trusted contact');
      });
    }

    // ---- Fix / Delete a "not received" entry (lender: contribution, payer: repayment) ----
    root.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.kind;
      const eid = b.dataset.entry;
      const e = (kind === 'contribution' ? contributions : repayments).find((x) => String(x.id) === eid);
      const slot = root.querySelector(`[data-slot="${kind}-${eid}"]`);
      if (!e || !slot) return;
      if (b.dataset.fix === 'delete') {
        askConfirm(slot, 'Delete this entry? It will be removed from the request.', 'Yes, delete it', 'Keep it',
          (btns) => guard(btns, null, () => (kind === 'contribution' ? window.Api.delete(`/contributions/${eid}`) : window.Api.delete(`/repayments/${eid}`)), 'Entry deleted'));
        return;
      }
      const fid = `${kind}-${eid}`;
      slot.innerHTML = `<form class="fix-form form" novalidate>
          <label for="fix-amount-${esc(fid)}">Amount (₹)</label>
          <input id="fix-amount-${esc(fid)}" name="amount" type="text" inputmode="decimal" autocomplete="off" required>
          <label for="fix-utr-${esc(fid)}">UTR (optional)</label>
          <input id="fix-utr-${esc(fid)}" name="utr" type="text" autocomplete="off">
          <p class="error" role="alert"></p>
          <div class="row-actions"><button class="btn btn-primary" type="submit">Save correction</button>
          <button class="btn btn-ghost" type="button" data-cancel>Cancel</button></div></form>`;
      const form = slot.querySelector('form');
      form.elements.amount.value = rupees(e.amountCents);
      form.elements.utr.value = e.utr || '';
      form.elements.amount.focus();
      form.querySelector('[data-cancel]').addEventListener('click', () => { slot.innerHTML = ''; });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const err = form.querySelector('.error');
        const code = form.elements.utr.value.trim();
        if (code && !UTR_RE.test(code)) { err.textContent = UTR_MSG; form.elements.utr.setAttribute('aria-invalid', 'true'); form.elements.utr.focus(); return; }
        form.elements.utr.removeAttribute('aria-invalid');
        const body = { amount: form.elements.amount.value.trim(), utr: code };
        const save = form.querySelector('[type="submit"]');
        guard([save], err, () => (kind === 'contribution' ? window.Api.patch(`/contributions/${eid}`, body) : window.Api.patch(`/repayments/${eid}`, body)), 'Corrected. They will be asked to confirm it again.');
      });
    }));

    // The Home "Fix" link opens #/request/<id>/contribution-<entry>: scroll to that entry and move focus to it.
    if (entry && /^(contribution|repayment)-\d+$/.test(entry)) {
      const target = root.querySelector(`#${entry}`);
      if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
    }

    root.querySelector('#verify-form')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      act(`/requests/${id}/verify`, { decision: ev.submitter.value, note: root.querySelector('#v-note').value }, 'Decision recorded');
    });

    const fundForm = root.querySelector('#fund-form');
    if (fundForm) {
      const slot = root.querySelector('#pay-box-slot');
      const amountInput = root.querySelector('#c-amount');
      const drawPay = () => {
        const parsed = window.Money.parseRupees(amountInput.value);
        const cents = parsed.paise && parsed.paise > 0 ? parsed.paise : r.remainingCents;
        slot.innerHTML = payBlock(payFor(r.borrowerId), { name: name(r.borrowerId) }, cents, r.id);
      };
      drawPay();
      amountInput.addEventListener('input', drawPay);
      fundForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const err = root.querySelector('#e-fund');
        const code = root.querySelector('#c-utr').value.trim();
        // P-46: the UTR is optional; when given it must be 6-35 letters or digits (and unique on this request, server side).
        if (code && !UTR_RE.test(code)) { err.textContent = UTR_MSG; root.querySelector('#c-utr').setAttribute('aria-invalid', 'true'); root.querySelector('#c-utr').focus(); return; }
        const body = { amount: amountInput.value.trim() };
        if (code) body.utr = code;
        const key = fundForm.dataset.idempotencyKey || (fundForm.dataset.idempotencyKey = newIdempotencyKey());
        try {
          await window.Api.post(`/requests/${id}/contributions`, body, { headers: { 'Idempotency-Key': key } });
          delete fundForm.dataset.idempotencyKey;
          toast('Thank you. The borrower will confirm it.'); rerender();
        } catch (e) {
          if (e.status && e.status < 500) delete fundForm.dataset.idempotencyKey;
          err.textContent = e.message; amountInput.setAttribute('aria-invalid', 'true'); amountInput.focus();
        }
      });
    }

    root.querySelectorAll('.repay-form').forEach((form) => {
      const slot = form.querySelector('.repay-pay');
      const owed = Number(slot.dataset.owed);
      const lid = Number(form.dataset.lender);
      const draw = () => {
        const parsed = window.Money.parseRupees(form.elements.amount.value);
        const cents = parsed.paise && parsed.paise > 0 ? parsed.paise : owed;
        slot.innerHTML = payBlock(payFor(lid), { name: name(lid) }, cents, r.id);
      };
      draw();
      form.elements.amount.addEventListener('input', draw);
    });
    root.querySelectorAll('.repay-form').forEach((form) => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = form.elements.amount;
      const err = form.querySelector('.error');
      const code = form.elements.utr.value.trim();
      if (code && !UTR_RE.test(code)) { err.textContent = UTR_MSG; form.elements.utr.setAttribute('aria-invalid', 'true'); form.elements.utr.focus(); return; }
      const key = form.dataset.idempotencyKey || (form.dataset.idempotencyKey = newIdempotencyKey());
      try {
        await window.Api.post(`/requests/${id}/repayments`, { lenderId: Number(form.dataset.lender), amount: input.value.trim(), utr: code }, { headers: { 'Idempotency-Key': key } });
        delete form.dataset.idempotencyKey;
        toast('Repayment recorded. The lender will confirm it.'); rerender();
      } catch (e) {
        if (e.status && e.status < 500) delete form.dataset.idempotencyKey;
        err.textContent = e.message; input.setAttribute('aria-invalid', 'true'); input.focus();
      }
    }));
  }

  window.RequestPage = { render, upiHref };
})();
