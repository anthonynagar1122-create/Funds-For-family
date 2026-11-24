(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const views = ['signed-out', 'view-home', 'view-feed', 'view-new', 'view-detail', 'view-invite', 'view-people', 'view-activity'];
  let me = null;
  let usersById = new Map();

  // Updates is the dashboard; Request, Contribute, Invite and Follow are the four actions.
  const navFor = { 'view-home': 'nav-home', 'view-activity': 'nav-home', 'view-detail': 'nav-home', 'view-new': 'nav-new', 'view-feed': 'nav-feed', 'view-invite': 'nav-invite', 'view-people': 'nav-people' };

  function show(id) {
    for (const v of views) { const el = document.getElementById(v); if (el) el.hidden = v !== id; }
    // Mark the current section in the segmented navigation.
    for (const navId of new Set(Object.values(navFor))) {
      const btn = document.getElementById(navId);
      if (btn) { if (navFor[id] === navId) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); }
    }
    $('#primary-nav').hidden = id === 'signed-out';
    if (id !== 'signed-out') $('#main').focus();
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.field = data.field; err.status = res.status; throw err; }
    return data;
  }

  async function loadUsers() {
    const { user } = await api('/me');
    me = user;
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
    const map = { pending_verification: ['badge-warn', 'Awaiting verification'], rejected: ['badge-danger', 'Rejected'],
      open: ['', 'Open for funding'], funded: ['badge-ok', 'Funded'], overdue: ['badge-danger', 'Overdue'], repaid: ['badge-ok', 'Repaid'] };
    const [cls, label] = map[status] ?? ['', status];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  // ---- Updates: the dashboard (what needs you, where your requests stand) ----
  const GROUPS = [
    { key: 'repay', title: 'To repay', action: 'Record repayment' },
    { key: 'verify', title: 'To verify', action: 'Review' },
    { key: 'mine', title: 'Your requests', action: 'View' },
  ];

  async function renderHome() {
    show('view-home');
    const safe = (p) => p.catch(() => null);
    const [feed, activity, queue, conns, sugg] = await Promise.all([
      safe(api('/feed')),
      safe(api('/activity')),
      me.isVerifier ? safe(api('/verification-queue')) : Promise.resolve({ requests: [] }),
      safe(api('/connections')),
      safe(api('/suggestions')),
    ]);

    const repayById = new Map();
    for (const r of [...(activity?.borrowing ?? []), ...(activity?.roles?.nominee ?? [])]) {
      if (r.status === 'funded' || r.status === 'overdue') repayById.set(r.requestId, r);
    }
    const items = {
      repay: [...repayById.values()]
        .sort((a, b) => (b.status === 'overdue') - (a.status === 'overdue') || String(a.repaymentDate).localeCompare(String(b.repaymentDate)))
        .map((r) => ({ id: r.requestId, purpose: r.purpose, status: r.status, sub: `${r.myRole === 'nominee' ? 'You are nominee' : 'Your request'} · repay by ${r.repaymentDate}` })),
      verify: (queue?.requests ?? []).map((r) => ({ id: r.id, purpose: r.purpose, status: r.status,
        sub: `${money(r.principalCents)} · ${r.approvals ?? 0} of ${r.requiredApprovals ?? 2} approvals` })),
      // Your own requests that are still moving: awaiting a check, open for funding, or just rejected.
      mine: (activity?.borrowing ?? []).filter((r) => ['pending_verification', 'open', 'rejected'].includes(r.status))
        .map((r) => ({ id: r.requestId, purpose: r.purpose, status: r.status, sub: `${money(r.principalCents)} · repay by ${r.repaymentDate}` })),
    };
    const fundable = (feed?.requests ?? []).filter((r) => r.status === 'open' && r.borrowerId !== me.id).length;

    $('#tile-verify').hidden = !me.isVerifier;
    // A source that failed shows "–", never a false zero.
    const sourceFailed = { repay: activity === null, verify: queue === null, mine: activity === null };
    for (const g of GROUPS) {
      $(`#count-${g.key}`).textContent = sourceFailed[g.key] ? '–' : String(items[g.key].length);
      $(`#tile-${g.key}`).dataset.failed = sourceFailed[g.key] ? '1' : '';
    }
    $('#count-fund').textContent = feed === null ? '–' : String(fundable);
    $('#nav-dot').hidden = items.repay.length + items.verify.length === 0;

    const failed = Object.values(sourceFailed).some(Boolean) || feed === null;
    const html = GROUPS.filter((g) => items[g.key].length > 0).map((g) => `
      <div class="section-card" id="group-${g.key}" tabindex="-1">
        <h2 class="group-title">${esc(g.title)} <span class="group-count">${items[g.key].length}</span></h2>
        <ul class="list task-list">${items[g.key].map((it) => `
          <li class="task${it.status === 'overdue' ? ' is-urgent' : ''}">
            <div class="task-main">
              <p class="card-eyebrow">Request #${esc(it.id)}</p>
              <a class="task-title" href="#request/${esc(it.id)}">${esc(String(it.purpose ?? '').slice(0, 90))}</a>
              <p class="task-sub">${statusBadge(it.status)} <span>${esc(it.sub)}</span></p>
            </div>
            <a class="btn ${g.key === 'mine' ? 'btn-secondary' : 'btn-primary'} btn-sm" href="#request/${esc(it.id)}">${esc(g.action)}</a>
          </li>`).join('')}
        </ul>
      </div>`).join('');
    // Growth: a small circle means few people can fund you. Offer suggestions and an invite.
    const circleSize = conns ? conns.following.length : Infinity;
    const top = (sugg?.suggestions ?? []).slice(0, 3);
    const grow = circleSize < 3 ? `
      <div class="section-card grow-card" id="grow-circle">
        <h2>Grow your circle</h2>
        <p class="muted">The people you follow can see and fund your requests.</p>
        ${top.length ? `<ul class="list">${top.map((x) => `<li><div class="task-main"><strong>${esc(x.user.name)}</strong>
          <p class="task-sub">${esc(x.reason)}</p></div>
          <div class="row-actions"><button class="btn btn-primary btn-sm" data-follow="${esc(x.user.id)}" type="button">Follow</button></div></li>`).join('')}</ul>` : ''}
        ${inviteNudge('Bring family in', 'Send your link. When they open it, you are connected both ways.')}
      </div>` : '';
    $('#home-groups').innerHTML = (failed ? '<p class="error" role="alert">Some updates could not be loaded. Refresh to try again.</p>' : '') + html + grow;
    $('#home-empty').hidden = html !== '' || failed;
  }

  document.addEventListener('click', (ev) => {
    const jump = ev.target.closest('[data-jump]');
    if (!jump) return;
    const group = document.getElementById(`group-${jump.dataset.jump}`);
    if (group) { group.scrollIntoView({ block: 'start' }); group.focus({ preventScroll: true }); }
    else if (jump.dataset.failed === '1') toast('Could not load this list. Refresh to try again.');
    else toast('Nothing here right now');
  });

  // ---- Contribute: fund open requests from your circle right on the card ----
  const QUICK_AMOUNTS = [10, 25, 50];

  async function renderFeed() {
    show('view-feed');
    const { requests } = await api('/feed');
    const list = $('#feed-list');
    list.innerHTML = '';
    let shown = 0;
    for (const r of requests) {
      const card = CardModel.requestCard(r, me);
      if (!card.actions.some((a) => a.id === 'contribute')) continue;
      shown++;
      const remaining = Math.max(0, (r.principalCents - (r.raisedCents ?? 0)) / 100);
      const chips = QUICK_AMOUNTS.filter((v) => v < remaining)
        .map((v) => `<button class="chip" type="button" data-amount="${v}">$${v}</button>`).join('')
        + `<button class="chip" type="button" data-amount="${remaining.toFixed(2)}">All $${remaining.toFixed(2)}</button>`;
      const li = document.createElement('li');
      li.className = `card fund-card card-${card.tone}`;
      li.innerHTML = `
        <p class="card-eyebrow">Request #${esc(r.id)}</p>
        <p class="card-title"><a href="#request/${r.id}">${esc(card.title)}</a></p>
        <div class="meta"><span>${esc(card.dueLabel)}</span></div>
        <div class="fund-progress">
          <div class="progress" role="progressbar" aria-label="Funding progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${card.progressPct}"><span style="width:${card.progressPct}%"></span></div>
          <p class="fund-figures"><strong>${esc(card.raisedLabel)}</strong> <span>$${remaining.toFixed(2)} to go</span></p>
        </div>
        <form class="fund-form" data-contribute="${esc(r.id)}" novalidate>
          <div class="chips" role="group" aria-label="Quick amounts">${chips}</div>
          <div class="fund-row">
            <label class="sr-only" for="amt-${esc(r.id)}">Amount to contribute (USD)</label>
            <input id="amt-${esc(r.id)}" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" max="${remaining.toFixed(2)}" placeholder="Amount" required>
            <button class="btn btn-primary" type="submit">Contribute</button>
          </div>
          <p class="error" role="alert"></p>
        </form>`;
      list.appendChild(li);
    }
    $('#feed-empty').hidden = shown > 0;
  }

  document.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip[data-amount]');
    if (!chip) return;
    const form = chip.closest('form');
    form.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    const input = form.querySelector('input[name="amount"]');
    input.value = chip.dataset.amount;
    input.focus();
  });

  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-contribute]');
    if (!form) return;
    ev.preventDefault();
    const input = form.querySelector('input[name="amount"]');
    const err = form.querySelector('.error');
    const amount = Number(input.value);
    err.textContent = '';
    if (!(amount > 0)) { err.textContent = 'Enter an amount.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api(`/requests/${form.dataset.contribute}/contributions`, { method: 'POST', body: { amount } });
      toast(`Contributed $${amount.toFixed(2)}. Thank you.`);
      renderFeed();
    } catch (e) {
      err.textContent = e.message; input.setAttribute('aria-invalid', 'true'); button.disabled = false; input.focus();
    }
  });

  // ---- New request ----
  async function renderNew() {
    show('view-new');
    const sel = $('#f-nominee');
    sel.innerHTML = '<option value="">Loading members…</option>';
    const { users } = await api('/users');
    sel.innerHTML = '<option value="">Choose a nominee</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    $('#f-date').min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
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
    const body = { amount: Number(fd.get('amount')), purpose: fd.get('purpose'), repaymentDate: fd.get('repaymentDate'), nomineeId: Number(fd.get('nomineeId')) };
    try {
      const { request } = await api('/requests', { method: 'POST', body });
      toast('Request submitted. The verification team will check it next.');
      location.hash = `#request/${request.id}`;
    } catch (err) {
      const field = err.field && document.getElementById(`e-${err.field === 'nomineeId' ? 'nominee' : err.field}`);
      if (field) { field.textContent = err.message; const input = field.previousElementSibling; input?.setAttribute('aria-invalid', 'true'); input?.focus?.(); }
      else $('#e-form').textContent = err.message;
    }
  });

  // ---- Request detail ----
  async function renderDetail(id) {
    show('view-detail');
    let r;
    try { ({ request: r } = await api(`/requests/${id}`)); }
    catch (err) {
      $('#detail').innerHTML = `<p><a class="detail-back" href="#home">← Home</a></p>
        <h1 id="detail-title">Request not available</h1>
        <p class="muted">${err.status === 404 ? 'It may have been removed, or it belongs to someone outside your circle.' : esc(err.message)}</p>`;
      return;
    }
    const pct = Math.min(100, Math.round(((r.principalCents - r.remainingCents) / r.principalCents) * 100));
    const borrower = await userName(r.borrowerId);
    const nominee = await userName(r.nomineeId);
    // Every role-based decision comes from the card model, so the page and the cards cannot disagree.
    const card = CardModel.requestCard(r, me);
    const can = (id) => card.actions.some((a) => a.id === id);

    $('#detail').innerHTML = `
      <p><a class="detail-back" href="#home">← Home</a></p>
      <p class="card-eyebrow">Request #${esc(r.id)}</p>
      <h1 id="detail-title">${esc(r.purpose)}</h1>
      <div class="meta">${statusBadge(r.status)}<span>Requested by ${esc(borrower)}</span><span>Nominee: ${esc(nominee)}</span></div>
      <div class="meta"><span>Principal ${money(r.principalCents)}</span><span>Repay by ${esc(r.repaymentDate)}</span>
        ${r.daysOverdue > 0 ? `<span>${r.daysOverdue} days overdue · interest ${money(r.interestCents)}</span>` : ''}
        <span>Amount due ${money(r.amountDueCents)}</span></div>
      ${r.status !== 'pending_verification' && r.status !== 'rejected' ? `
        <div class="progress" role="progressbar" aria-label="Funding progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <p class="muted">${money(r.principalCents - r.remainingCents)} raised of ${money(r.principalCents)}</p>` : ''}
      <h2>Verification</h2>
      <ul class="list">${r.verifications.length ? r.verifications.map((v) => `<li>${v.decision === 'approve' ? '<span class="badge badge-ok">Approved</span>' : '<span class="badge badge-danger">Rejected</span>'}${v.note ? '<span>' + esc(v.note) + '</span>' : ''}</li>`).join('') : '<li class="muted">No decisions yet. Two approvals are needed.</li>'}</ul>
      ${can('verify-approve') ? `
        <form id="verify-form" class="form">
          <div class="field"><label for="v-note">Note (optional)</label><textarea id="v-note" rows="2" maxlength="1000"></textarea></div>
          <div class="row-actions">
            <button class="btn btn-primary" name="decision" value="approve" type="submit">Approve purpose</button>
            <button class="btn btn-secondary" name="decision" value="reject" type="submit">Reject</button>
          </div>
        </form>` : ''}
      ${can('contribute') ? `
        <form id="fund-form" class="form">
          <div class="field"><label for="c-amount">Contribute (USD, up to ${money(r.remainingCents)})</label>
            <input id="c-amount" type="number" min="0.01" step="0.01" max="${(r.remainingCents / 100).toFixed(2)}" required>
            <p class="hint">Record what you are lending. No money moves through this app.</p>
            <p class="error" id="e-fund" role="alert"></p></div>
          <button class="btn btn-primary" type="submit">Contribute</button>
        </form>` : ''}
      ${can('repay') ? `
        <form id="repay-form" class="form">
          <div class="field"><label for="p-amount">Record a repayment (USD)</label>
            <input id="p-amount" type="number" min="0.01" step="0.01" required>
            <p class="hint">Record money you have already paid back. No money moves through this app.</p>
            <p class="error" id="e-repay" role="alert"></p></div>
          <button class="btn btn-primary" type="submit">Record repayment</button>
        </form>` : ''}
      `;
    // Land on the one thing this member can do here.
    // Growth: the borrower's request is funded faster when more people can see it.
    if (card.role === 'borrower' && (r.status === 'pending_verification' || r.status === 'open')) {
      $('#detail').insertAdjacentHTML('beforeend', inviteNudge('Get it funded faster',
        'Only people you follow can see and fund this request. Invite family so more of them can help.'));
    }
    // On desktop, put the cursor in the action without scrolling past the request details.
    // On touch devices, do not pop up the keyboard over the details.
    const firstAction = $('#detail form textarea, #detail form input, #detail form button');
    if (firstAction && window.matchMedia('(pointer: fine)').matches) firstAction.focus({ preventScroll: true });

    const verify = $('#verify-form');
    verify?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const decision = ev.submitter.value;
      try { await api(`/requests/${id}/verify`, { method: 'POST', body: { decision, note: $('#v-note').value } }); toast('Decision recorded'); location.hash = '#home'; }
      catch (err) { toast(err.message); }
    });
    $('#fund-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#c-amount');
      try { await api(`/requests/${id}/contributions`, { method: 'POST', body: { amount: Number(input.value) } }); toast('Thank you for contributing'); renderDetail(id); }
      catch (err) { $('#e-fund').textContent = err.message; input.setAttribute('aria-invalid', 'true'); input.focus(); }
    });
    $('#repay-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#p-amount');
      try { await api(`/requests/${id}/repayments`, { method: 'POST', body: { amount: Number(input.value) } }); toast('Repayment recorded'); renderDetail(id); }
      catch (err) { $('#e-repay').textContent = err.message; input.setAttribute('aria-invalid', 'true'); input.focus(); }
    });
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
      roles: [...data.roles.nominee, ...data.roles.verifier],
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
    show('view-people');
    const [{ following, followers, mutual }, sugg] = await Promise.all([
      api('/connections'),
      api('/suggestions').catch(() => ({ suggestions: [] })),
    ]);
    const mutualIds = new Set(mutual.map((u) => u.id));
    const followingIds = new Set(following.map((u) => u.id));
    const row = (u) => `<li><strong>${esc(u.name)}</strong>
      ${mutualIds.has(u.id) ? '<span class="badge badge-primary">Mutual</span>' : followingIds.has(u.id) ? '<span class="badge badge-neutral">Following</span>' : '<span class="badge badge-neutral">Follows you</span>'}
      <div class="row-actions">${followingIds.has(u.id)
        ? `<button class="btn btn-ghost btn-sm" data-unfollow="${u.id}" type="button">Unfollow</button>`
        : `<button class="btn btn-secondary btn-sm" data-follow="${u.id}" type="button">Follow back</button>`}</div></li>`;
    $('#connections').innerHTML = [...following, ...followers.filter((u) => !followingIds.has(u.id))].map(row).join('')
      || '<li class="muted">No connections yet. Share your invite link to start your circle.</li>';

    const list = sugg.suggestions ?? [];
    $('#suggestions-card').hidden = list.length === 0;
    $('#suggestions').innerHTML = list.map((x) => `<li>
      <div class="task-main"><strong>${esc(x.user.name)}</strong>
        <p class="task-sub">${esc(x.reason)}${x.mutualNames?.length ? ` · ${esc(x.mutualNames.join(', '))}${x.mutualCount > x.mutualNames.length ? ' and others' : ''}` : ''}</p></div>
      <div class="row-actions"><button class="btn btn-primary btn-sm" data-follow="${esc(x.user.id)}" type="button">Follow</button></div></li>`).join('');
  }

  // Share an invite link: the phone's share sheet (WhatsApp, SMS…) where available, otherwise copy it.
  // Any button with data-share-invite does this; it reports into the nearest [data-share-status] in its container.
  async function shareInvite(button) {
    const scope = button.closest('[data-share-scope]') ?? document;
    const status = scope.querySelector('[data-share-status]');
    const box = scope.querySelector('[data-share-link]');
    const say = (msg) => { if (status) status.textContent = msg; };
    try {
      const { link } = await api('/invites', { method: 'POST', body: {} });
      if (box) { box.value = link; box.hidden = false; }
      const text = `${me?.name ?? 'I'} invited you to our family circle on Funds For Family`;
      if (navigator.share) {
        try { await navigator.share({ title: 'Funds For Family', text, url: link }); say('Invite shared.'); return; }
        catch (err) { if (err?.name === 'AbortError') { say(''); return; } }
      }
      try { await navigator.clipboard.writeText(link); say('Invite link copied. Paste it into WhatsApp, SMS or email.'); }
      catch { box?.select(); say('Copy this link and send it to the person you are inviting.'); }
    } catch (err) { say(err.message); }
  }
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-share-invite]');
    if (button) shareInvite(button);
  });

  // One small block that nudges growth: share an invite. Used after requesting and when a circle is small.
  const inviteNudge = (title, body) => `
    <div class="nudge" data-share-scope>
      <div class="nudge-text"><p class="nudge-title">${esc(title)}</p><p class="nudge-body">${esc(body)}</p></div>
      <button class="btn btn-primary" type="button" data-share-invite>Share invite link</button>
      <input class="invite-link" type="text" readonly hidden data-share-link aria-label="Your invite link">
      <p class="nudge-status" role="status" data-share-status></p>
    </div>`;

  // Opening an invite link (/?invite=…) connects the new member with the inviter once they are signed in.
  let inviteToken = new URLSearchParams(location.search).get('invite');
  async function acceptInviteIfAny() {
    if (!inviteToken) return;
    const token = inviteToken;
    inviteToken = null; // Clerk can call refresh several times: accept once.
    try {
      const { inviter } = await api('/invites/accept', { method: 'POST', body: { token } });
      toast(`You are now connected with ${inviter.name}`);
    } catch (err) { toast(err.message); }
    history.replaceState(null, '', location.pathname + location.hash);
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
      if (f || u) route();
    } catch (err) { toast(err.message); }
  });

  $('#invite-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#f-invite').value;
    try { await api('/invites', { method: 'POST', body: { email } }); $('#invite-status').textContent = `Invitation sent to ${email}.`; $('#f-invite').value = ''; }
    catch (err) { $('#invite-status').textContent = err.message; }
  });

  // ---- Routing ----
  async function route() {
    if (!me) return;
    const hash = location.hash.replace(/^#/, '') || 'home';
    if (hash.startsWith('request/')) return renderDetail(hash.split('/')[1]);
    if (hash === 'new') return renderNew();
    if (hash === 'people') return renderPeople();
    if (hash === 'invite') { show('view-invite'); return; }
    if (hash === 'activity') return renderActivity();
    if (hash === 'feed') return renderFeed();
    return renderHome();
  }
  window.addEventListener('hashchange', route);
  // Clicking the current section re-renders it (no hashchange fires for the same hash).
  const go = (hash) => () => { if (location.hash === hash) route(); else location.hash = hash; };
  $('#nav-home').addEventListener('click', go('#home'));
  $('#nav-feed').addEventListener('click', go('#feed'));
  $('#nav-people').addEventListener('click', go('#people'));
  $('#nav-new').addEventListener('click', go('#new'));
  $('#nav-invite').addEventListener('click', go('#invite'));

  // ---- Clerk sign-in ----
  async function boot() {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (!cfg.clerkPublishableKey) { $('#auth-slot').textContent = 'Sign-in is not configured.'; show('signed-out'); return; }
    const clerk = new window.Clerk(cfg.clerkPublishableKey);
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
      if (!clerk.user) {
        me = null;
        if (inviteToken) $('#signin-lede').textContent = 'You have been invited to a family circle. Sign in to join.';
        show('signed-out'); return;
      }
      try { await loadUsers(); await acceptInviteIfAny(); route(); }
      catch (err) { toast(err.message); }
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
