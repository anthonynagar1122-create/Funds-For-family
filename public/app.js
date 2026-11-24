(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const money = (cents) => Money.formatInr(cents);
  const esc = Format.esc;
  const views = ['signed-out', 'view-feed', 'view-new', 'view-not-invited', 'view-detail', 'view-circle', 'view-activity', 'view-profile'];
  // An invite link looks like /app/#join=<token>. Keep the token for the first /api/me, then tidy the address bar.
  const joinMatch = /^#join=([^&]+)/.exec(location.hash);
  if (joinMatch) {
    try { sessionStorage.setItem('ffjoin', decodeURIComponent(joinMatch[1])); } catch { /* storage unavailable */ }
    history.replaceState(null, '', location.pathname + location.search);
  }
  let me = null;
  let usersById = new Map();

  function show(id) {
    for (const v of views) { const el = document.getElementById(v); if (el) el.hidden = v !== id; }
    if (id !== 'signed-out') $('#main').focus();
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3500);
  }

  // Thin adapter over Api so the existing views keep their call style.
  const api = (path, opts = {}) => Api.request(opts.method || 'GET', path, opts.body, { headers: opts.headers });

  async function loadUsers() {
    const token = sessionStorage.getItem('ffjoin');
    const { user } = await Api.get('/me', token ? { headers: { 'x-invite-token': token } } : undefined);
    sessionStorage.removeItem('ffjoin');
    me = user;
    Nav.setUser(user);
    usersById = new Map([[user.id, user]]);
    return user;
  }

  async function userName(id) {
    if (!usersById.has(id)) {
      const { user } = await api(`/users/${id}`).catch(() => ({ user: null }));
      if (user) usersById.set(user.id, user);
    }
    return usersById.get(id)?.name ?? 'Member';
  }

  function statusBadge(status) {
    const map = { awaiting_contact: ['badge-warn', 'Waiting for trusted contact'], contact_declined: ['badge-danger', 'Trusted contact declined'],
      withdrawn: ['', 'Withdrawn'], closed: ['', 'Closed'], pending_verification: ['badge-warn', 'Awaiting verification'], rejected: ['badge-danger', 'Rejected'],
      open: ['', 'Open for funding'], funded: ['badge-ok', 'Funded'], overdue: ['badge-danger', 'Overdue'], repaid: ['badge-ok', 'Repaid'] };
    const [cls, label] = map[status] ?? ['', status];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  // ---- Feed ----
  async function renderFeed() {
    show('view-feed');
    const { requests } = await api('/feed');
    const list = $('#feed-list');
    $('#feed-empty').hidden = requests.length > 0;
    list.innerHTML = '';
    for (const r of requests) {
      const card = CardModel.requestCard(r, me);
      const li = document.createElement('li');
      li.className = `card card-${card.tone}`;
      const actions = card.actions
        .map((a) => `<a class="btn btn-sm btn-${a.tone === 'primary' ? 'primary' : 'ghost'}" href="#request/${r.id}" data-action="${esc(a.id)}">${esc(a.label)}</a>`)
        .join(' ');
      li.innerHTML = `
        <p class="card-title"><a href="#request/${r.id}">${esc(card.title)}</a></p>
        <div class="meta"><span>${esc(card.raisedLabel)}</span><span>${esc(card.dueLabel)}</span><span class="badge badge-${esc(card.tone)}">${esc(card.statusLabel)}</span></div>
        <div class="progress" role="progressbar" aria-label="Funding progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${card.progressPct}"><span style="width:${card.progressPct}%"></span></div>
        <div class="row-actions">${actions}</div>`;
      list.appendChild(li);
    }
  }

  // ---- New request ----
  async function renderNew() {
    show('view-new');
    const sel = $('#f-contact');
    sel.innerHTML = '<option value="">Loading members…</option>';
    const { users } = await api('/users');
    sel.innerHTML = '<option value="">Choose a trusted contact</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    $('#f-date').min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const limit = new Date(); limit.setMonth(limit.getMonth() + 12);
    $('#f-date').max = limit.toISOString().slice(0, 10);
  }

  function clearErrors(form) {
    form.querySelectorAll('.error').forEach((e) => (e.textContent = ''));
    form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  }

  $('#new-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    clearErrors(form);
    const fd = new FormData(form);
    const body = { amount: String(fd.get('amount')).trim(), purpose: fd.get('purpose'), category: fd.get('category'), repaymentDate: fd.get('repaymentDate'), trustedContactId: Number(fd.get('trustedContactId')) };
    try {
      const { request } = await api('/requests', { method: 'POST', body });
      toast('Request sent to your trusted contact');
      Router.go(`#request/${request.id}`);
    } catch (err) {
      const field = err.field && document.getElementById(`e-${err.field}`);
      if (field) { field.textContent = err.message; const input = field.previousElementSibling; input?.setAttribute('aria-invalid', 'true'); input?.focus?.(); }
      else $('#e-form').textContent = err.message;
    }
  });

  // ---- Request detail ----
  // Minimal markup: the Phase B redesign replaces this page.
  async function renderDetail(id) {
    show('view-detail');
    const { request: r } = await api(`/requests/${id}`);
    const confirmed = r.totals?.confirmedCents ?? 0;
    const pending = r.totals?.pendingCents ?? 0;
    const pct = r.principalCents > 0 ? Math.min(100, Math.floor((confirmed * 100) / r.principalCents)) : 0;
    const lenders = r.lenders || [];
    const contributions = r.contributions || [];
    const repayments = r.repayments || [];
    const ids = new Set([r.borrowerId, r.trustedContactId, ...lenders.map((l) => l.userId), ...contributions.map((c) => c.contributorId), ...repayments.flatMap((p) => [p.payerId, p.lenderId])]);
    const names = new Map(await Promise.all([...ids].map(async (uid) => [uid, await userName(uid)])));
    const name = (uid) => names.get(uid) ?? 'Member';
    // Every role-based decision comes from the card model, so the page and the cards cannot disagree.
    const card = CardModel.requestCard(r, me);
    const can = (aid) => card.actions.some((a) => a.id === aid);
    const isBorrower = me.id === r.borrowerId;
    const repayable = can('repay');
    const utr = (x) => (x.utr ? ` · UTR ${esc(x.utr)}` : '');

    const contributionRow = (c) => `<li>${esc(name(c.contributorId))} · ${money(c.amountCents)} · ${esc(c.status)}${utr(c)}
        ${isBorrower && c.status === 'sent' ? `<span class="row-actions">
          <button class="btn btn-sm btn-primary" type="button" data-confirm-contribution="${esc(c.id)}">Confirm</button>
          <button class="btn btn-sm btn-ghost" type="button" data-notreceived-contribution="${esc(c.id)}">Not received</button></span>` : ''}</li>`;
    const repaymentRow = (p) => `<li>${esc(name(p.payerId))} to ${esc(name(p.lenderId))} · ${money(p.amountCents)} · ${esc(p.status)}${utr(p)}
        ${me.id === p.lenderId && p.status === 'sent' ? `<span class="row-actions">
          <button class="btn btn-sm btn-primary" type="button" data-confirm-repayment="${esc(p.id)}">Confirm</button>
          <button class="btn btn-sm btn-ghost" type="button" data-notreceived-repayment="${esc(p.id)}">Not received</button></span>` : ''}</li>`;
    const lenderRow = (l) => `<li class="lender-row"><strong>${esc(name(l.userId))}</strong>
        <span class="muted">lent ${money(l.lentCents)} · repaid ${money(l.repaidCents)}${l.pendingRepayCents > 0 ? ` · ${money(l.pendingRepayCents)} awaiting confirmation` : ''} · still owed ${money(l.owedCents)}</span>
        ${repayable && l.owedCents > 0 ? `<form class="repay-form form" data-lender="${esc(l.userId)}">
          <label for="p-amount-${esc(l.userId)}">Repay ${esc(name(l.userId))} (₹)</label>
          <input id="p-amount-${esc(l.userId)}" name="amount" type="text" inputmode="decimal" autocomplete="off" required>
          <label for="p-utr-${esc(l.userId)}">UTR (optional)</label>
          <input id="p-utr-${esc(l.userId)}" name="utr" type="text" autocomplete="off">
          <p class="error" role="alert"></p>
          <button class="btn btn-primary" type="submit">Repay</button></form>` : ''}</li>`;

    $('#detail').innerHTML = `
      <p><a href="#/home">← Back to home</a></p>
      <h1 id="detail-title">${esc(r.purpose)}</h1>
      <div class="meta">${statusBadge(r.status)}<span>Requested by ${esc(name(r.borrowerId))}</span><span>Trusted contact: ${esc(name(r.trustedContactId))}</span></div>
      <div class="meta"><span>Amount ${money(r.principalCents)}</span><span>Repay by ${esc(r.repaymentDate)}</span>
        ${r.daysOverdue > 0 ? `<span>${r.daysOverdue} days overdue</span>` : ''}</div>
      ${r.rejectionReason ? `<p class="error">${esc(r.rejectionReason)}</p>` : ''}
      ${['open', 'funded', 'overdue', 'repaid'].includes(r.status) ? `
        <div class="progress" role="progressbar" aria-label="Funding progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <p class="muted">${money(confirmed)} confirmed · ${money(pending)} pending · of ${money(r.principalCents)}</p>` : ''}
      ${can('contact-accept') ? `
        <div class="row-actions" style="margin-top:16px">
          <button class="btn btn-primary" type="button" data-contact="accept">Accept</button>
          <button class="btn btn-secondary" type="button" data-contact="decline">Decline</button></div>` : ''}
      <h2>Verification</h2>
      <ul class="list">${r.verifications.length ? r.verifications.map((v) => `<li>${v.decision === 'approve' ? 'Approved' : 'Rejected'}${v.note ? ': ' + esc(v.note) : ''}</li>`).join('') : '<li class="muted">No decisions yet. Two approvals are needed.</li>'}</ul>
      ${can('verify-approve') ? `
        <form id="verify-form" class="form" style="margin-top:16px">
          <div class="field"><label for="v-note">Note (optional)</label><textarea id="v-note" rows="2" maxlength="1000"></textarea></div>
          <div class="row-actions">
            <button class="btn btn-primary" name="decision" value="approve" type="submit">Approve purpose</button>
            <button class="btn btn-secondary" name="decision" value="reject" type="submit">Reject</button>
          </div>
        </form>` : ''}
      ${can('contribute') ? `
        ${(r.payTo || []).length ? `<h2>Send the money by UPI</h2><ul class="list">${r.payTo.map((t) => `<li>${esc(t.name)}: ${esc(t.upiId)}</li>`).join('')}</ul>` : ''}
        <form id="fund-form" class="form" style="margin-top:16px">
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
      <p class="muted" style="margin-top:24px">Payments are recorded here for transparency. No money moves through this app. A payment counts once the person receiving it confirms.</p>`;

    const act = async (path, body, message) => {
      try { await api(path, { method: 'POST', body: body ?? {} }); toast(message); renderDetail(id); }
      catch (err) { toast(err.message); }
    };
    const detailEl = $('#detail');
    detailEl.querySelectorAll('[data-contact]').forEach((b) => b.addEventListener('click', () => act(`/requests/${id}/contact-decision`, { decision: b.dataset.contact }, 'Answer recorded')));
    detailEl.querySelectorAll('[data-confirm-contribution]').forEach((b) => b.addEventListener('click', () => act(`/contributions/${b.dataset.confirmContribution}/confirm`, null, 'Contribution confirmed')));
    detailEl.querySelectorAll('[data-notreceived-contribution]').forEach((b) => b.addEventListener('click', () => act(`/contributions/${b.dataset.notreceivedContribution}/not-received`, null, 'Marked as not received')));
    detailEl.querySelectorAll('[data-confirm-repayment]').forEach((b) => b.addEventListener('click', () => act(`/repayments/${b.dataset.confirmRepayment}/confirm`, null, 'Repayment confirmed')));
    detailEl.querySelectorAll('[data-notreceived-repayment]').forEach((b) => b.addEventListener('click', () => act(`/repayments/${b.dataset.notreceivedRepayment}/not-received`, null, 'Marked as not received')));

    $('#verify-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const decision = ev.submitter.value;
      act(`/requests/${id}/verify`, { decision, note: $('#v-note').value }, 'Decision recorded');
    });
    $('#fund-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#c-amount');
      const body = { amount: input.value.trim() };
      const code = $('#c-utr').value.trim();
      if (code) body.utr = code;
      try { await api(`/requests/${id}/contributions`, { method: 'POST', body }); toast('Thank you. The borrower will confirm it.'); renderDetail(id); }
      catch (err) { $('#e-fund').textContent = err.message; input.setAttribute('aria-invalid', 'true'); input.focus(); }
    });
    detailEl.querySelectorAll('.repay-form').forEach((form) => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = form.elements.amount;
      try {
        await api(`/requests/${id}/repayments`, { method: 'POST', body: { lenderId: Number(form.dataset.lender), amount: input.value.trim(), utr: form.elements.utr.value.trim() } });
        toast('Repayment recorded. The lender will confirm it.'); renderDetail(id);
      } catch (err) { form.querySelector('.error').textContent = err.message; input.setAttribute('aria-invalid', 'true'); input.focus(); }
    }));
  }

  // ---- My activity (loop A) ----
  async function renderActivity() {
    show('view-activity');
    let data;
    try {
      data = await api('/activity');
    } catch (err) {
      $('#view-activity').querySelectorAll('[id^="activity-"]').forEach((el) => {
        el.innerHTML = `<p class="error" role="alert">Could not load your activity. ${esc(err.message)}</p>`;
      });
      return;
    }
    const groups = {
      borrowing: data.borrowing,
      lending: data.lending,
      repayments: [...data.repayments.made, ...data.repayments.received],
      roles: [...data.roles.trustedContact, ...data.roles.verifier],
    };
    for (const [name, rows] of Object.entries(groups)) {
      const box = $(`#activity-${name}`);
      if (rows.length === 0) {
        box.innerHTML = '<p class="empty">Nothing here yet.</p>';
        continue;
      }
      box.innerHTML = `<ul class="list">${rows.map((r) => `
        <li><a href="#request/${esc(r.requestId)}">${esc((r.purpose || '').slice(0, 90))}</a>
          <span class="muted">${esc(r.myRole)}${r.myAmountCents > 0 ? ` · ${money(r.myAmountCents)}` : ''} · ${esc(r.repaymentDate)}</span>
          ${statusBadge(r.status)}</li>`).join('')}</ul>`;
    }
  }

  // ---- People ----
  async function renderPeople() {
    show('view-circle');
    const { following, followers, mutual } = await api('/connections');
    const mutualIds = new Set(mutual.map((u) => u.id));
    const row = (u) => `<li><strong>${esc(u.name)}</strong> <span class="muted">${esc(u.email)}</span>
      ${mutualIds.has(u.id) ? '<span class="badge">Mutual</span>' : ''}
      <div class="row-actions"><button class="btn btn-secondary" data-follow="${u.id}" type="button">Follow</button>
      <button class="btn btn-ghost" data-unfollow="${u.id}" type="button">Unfollow</button></div></li>`;
    $('#connections').innerHTML = [...following, ...followers.filter((u) => !following.some((f) => f.id === u.id))].map(row).join('') || '<li class="muted">No connections yet.</li>';
  }

  $('#search-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = $('#f-search').value.trim();
    const { users } = await api(`/users?q=${encodeURIComponent(q)}`);
    $('#search-results').innerHTML = users.map((u) => `<li><strong>${esc(u.name)}</strong> <span class="muted">${esc(u.email)}</span>
      <div class="row-actions"><button class="btn btn-secondary" data-follow="${u.id}" type="button">Follow</button></div></li>`).join('') || '<li class="muted">No members found.</li>';
  });

  document.addEventListener('click', async (ev) => {
    const f = ev.target.closest('[data-follow]');
    const u = ev.target.closest('[data-unfollow]');
    try {
      if (f) { await api('/follows', { method: 'POST', body: { userId: Number(f.dataset.follow) } }); toast('Following'); }
      if (u) { await api(`/follows/${u.dataset.unfollow}`, { method: 'DELETE' }); toast('Unfollowed'); }
      if (f || u) renderPeople();
    } catch (err) { toast(err.message); }
  });

  $('#invite-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#f-invite').value;
    try { await api('/invites', { method: 'POST', body: { email } }); $('#invite-status').textContent = `Invitation sent to ${email}.`; ev.target.reset(); }
    catch (err) { $('#invite-status').textContent = err.message; }
  });

  // ---- Profile (placeholder until its own page lands) ----
  function renderProfile() {
    show('view-profile');
    $('#profile-card').innerHTML = `<p>${Format.avatar(me)} <strong>${esc(me.name)}</strong></p><p class="muted">${esc(me.email)}</p>`;
  }

  // ---- Routing ----
  // Renderers only run for a signed-in member.
  const guarded = (fn) => (...args) => (me ? fn(...args) : undefined);
  Router.register('home', guarded(renderFeed));
  Router.register('new', guarded(renderNew));
  Router.register('requests', guarded(renderActivity));
  Router.register('request', guarded((id) => (id ? renderDetail(id) : renderActivity())));
  Router.register('circle', guarded(renderPeople));
  Router.register('profile', guarded(renderProfile));
  let routerStarted = false;
  function route() {
    if (!me) return undefined;
    if (routerStarted) return Router.refresh();
    routerStarted = true;
    return Router.start();
  }

  // ---- Clerk sign-in ----
  async function boot() {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (!cfg.clerkPublishableKey) { $('#auth-slot').textContent = 'Sign-in is not configured.'; show('signed-out'); return; }
    // Live keys reach Clerk through the same-origin proxy; development keys do not need it.
    const clerk = new window.Clerk(cfg.clerkPublishableKey, cfg.clerkProxyUrl ? { proxyUrl: cfg.clerkProxyUrl } : undefined);
    await clerk.load();
    const mountAuth = () => {
      if (clerk.user) {
        clerk.mountUserButton(document.getElementById('auth-slot'));
      } else {
        $('#auth-slot').innerHTML = '<button class="btn btn-secondary" id="top-sign-in" type="button">Sign in</button>';
        $('#top-sign-in').addEventListener('click', () => clerk.openSignIn());
      }
    };
    const refresh = async () => {
      mountAuth();
      if (!clerk.user) { me = null; show('signed-out'); return; }
      try { await loadUsers(); route(); }
      catch (err) {
        if (err.code === 'invite_only') { me = null; show('view-not-invited'); return; }
        toast(err.message);
      }
    };
    $('#sign-in').addEventListener('click', () => clerk.openSignIn());
    clerk.addListener(refresh);
    await refresh();
  }

  const wait = () => new Promise((resolve) => {
    if (window.Clerk) return resolve();
    const t = setInterval(() => { if (window.Clerk) { clearInterval(t); resolve(); } }, 50);
    setTimeout(() => { clearInterval(t); resolve(); }, 10000);
  });
  wait().then(boot).catch((err) => { $('#auth-slot').textContent = 'Could not load sign-in.'; console.error(err); show('signed-out'); });
})();
