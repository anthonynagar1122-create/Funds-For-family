(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const money = (cents) => Money.formatInr(cents);
  const esc = Format.esc;
  const views = ['signed-out', 'view-home', 'view-feed', 'view-new', 'view-not-invited', 'view-detail', 'view-circle', 'view-activity', 'view-profile', 'view-welcome', 'view-workspace'];
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
    try { await NewRequestPage.render($('#new-root'), { toast, go: (h) => Router.go(h) }); }
    catch (err) { $('#new-root').innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`; }
    $('#new-title')?.focus();
  }

  // ---- Request detail ----
  async function renderDetail(id) {
    show('view-detail');
    try { await RequestPage.render($('#detail'), { id, me, userName, toast, rerender: () => renderDetail(id) }); }
    catch (err) { $('#detail').innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`; }
    $('#detail-title')?.focus();
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

  // ---- Circle ----
  async function renderPeople() {
    show('view-circle');
    try { await CirclePage.render($('#circle'), { toast }); } catch (err) { $('#circle').innerHTML = `<p class="error" role="alert">Could not load your circle. ${esc(err.message)}</p>`; }
    $('#circle-title')?.focus();
  }

  // ---- Profile and statement ----
  let clerkInstance = null;
  async function signOut() {
    await Api.clearSaved().catch(() => {});
    if (clerkInstance) await clerkInstance.signOut();
  }
  async function renderProfile(sub) {
    show('view-profile');
    const ctx = { me, toast, signOut, onUser: (u) => { me = { ...me, ...u }; Nav.setUser(me); } };
    try {
      if (sub === 'statement') await ProfilePage.renderStatement($('#profile'), ctx);
      else await ProfilePage.render($('#profile'), ctx);
    } catch (err) { $('#profile').innerHTML = `<p class="error" role="alert">Could not load this page. ${esc(err.message)}</p>`; }
    $('#profile-heading, #statement-heading')?.focus();
  }

  // ---- Admin / verifier workspace ----
  async function renderWorkspace() {
    show('view-workspace');
    const root = $('#workspace');
    if (!me || (!me.isAdmin && !me.isVerifier)) {
      root.innerHTML = '<h1 id="workspace-title" tabindex="-1">Workspace</h1><p class="empty">You do not have access to this workspace.</p>';
      return;
    }
    root.innerHTML = '<p class="muted" role="status">Loading workspace…</p>';
    let queue = [];
    let messages = [];
    let members = [];
    let metrics = null;
    let auditEvents = [];
    if (me.isVerifier) {
      try {
        const data = await api('/home');
        queue = (data.needsYou || []).filter((item) => item.kind === 'verify');
      } catch (err) {
        root.innerHTML = `<h1 id="workspace-title" tabindex="-1">Verification workspace</h1><p class="error" role="alert">${esc(err.message)}</p>`;
        return;
      }
    }
    if (me.isAdmin) {
      try {
        const results = await Promise.all([
          api('/admin/help-messages'), api('/admin/members'), api('/admin/operations'), api('/admin/audit-events'),
        ]);
        messages = results[0].messages || [];
        members = results[1].members || [];
        metrics = results[2].metrics || null;
        auditEvents = results[3].events || [];
        messages.sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)) || new Date(b.createdAt) - new Date(a.createdAt));
      } catch (err) {
        root.innerHTML = `<h1 id="workspace-title" tabindex="-1">Admin workspace</h1><p class="error" role="alert">${esc(err.message)}</p>`;
        return;
      }
    }
    const queueHtml = me.isVerifier
      ? `<section aria-labelledby="verification-queue-title"><h2 id="verification-queue-title">Verification queue (${queue.length})</h2>${queue.length
        ? `<ul class="cards">${queue.map((item) => `<li class="card"><p class="card-title">Request awaiting your review</p><p class="muted">Review the purpose and available context before deciding.</p><a class="btn btn-primary btn-sm" href="#/request/${encodeURIComponent(item.requestId)}">Open request</a></li>`).join('')}</ul>`
        : '<p class="empty">No requests are waiting for your verification.</p>'}</section>`
      : '';
    const helpHtml = me.isAdmin
      ? '<section aria-labelledby="support-inbox-title"><h2 id="support-inbox-title">Support inbox (' + messages.filter((m)=>!m.resolvedAt).length + ' open)</h2>' +
        (messages.length ? '<ul class="cards">' + messages.map((m) => {
          const options=members.filter((u)=>u.isAdmin||u.isVerifier).map((u)=>
            '<option value="' + esc(u.id) + '" ' + (m.assignedToId===u.id?'selected':'') + '>' +
            esc(u.name) + (u.isAdmin?' · Admin':' · Verifier') + '</option>').join('');
          return '<li class="card"><div class="meta"><strong>' + esc(m.name) + '</strong><span>' +
            esc(m.email || 'Email unavailable') + '</span><span>' + esc(new Date(m.createdAt).toLocaleString()) +
            '</span><span class="badge">' + (m.resolvedAt?'Resolved':'Open') + '</span></div><p class="help-body">' +
            esc(m.body) + '</p><p class="muted">' + (m.assignedToName?'Assigned to '+esc(m.assignedToName):'Unassigned') +
            '</p><div class="row-actions"><label>Assignee <select data-assignee-for="' + esc(m.id) +
            '"><option value="">Unassigned</option>' + options + '</select></label><button class="btn btn-secondary btn-sm" type="button" data-assign-help="' +
            esc(m.id) + '">Save assignment</button>' + (m.resolvedAt?'':'<button class="btn btn-secondary btn-sm" type="button" data-resolve-help="' +
            esc(m.id) + '">Mark resolved</button>') + '</div></li>';
        }).join('') + '</ul>' : '<p class="empty">There are no support messages yet.</p>') + '</section>'
      : '';
    root.innerHTML = `<h1 id="workspace-title" tabindex="-1">${me.isAdmin ? 'Admin workspace' : 'Verifier workspace'}</h1>
      <p class="muted">Restricted operational tools. Access is determined by your account role.</p>
      ${queueHtml}${helpHtml}`;
    if (me.isAdmin) {
      const metricItems = metrics ? [
        ['Members', metrics.members], ['Admins', metrics.admins], ['Verifiers', metrics.verifiers],
        ['Requests', metrics.requests], ['Awaiting contact', metrics.awaitingContact],
        ['Awaiting verification', metrics.pendingVerification], ['Open funding', metrics.openFunding],
        ['Funded', metrics.funded], ['Open support', metrics.supportOpen],
      ] : [];
      const metricSection = document.createElement('section');
      metricSection.setAttribute('aria-labelledby', 'operations-title');
      metricSection.innerHTML = '<h2 id="operations-title">Operations overview</h2><ul class="cards">' +
        metricItems.map(([label, value]) => '<li class="card"><p class="muted">' + esc(label) + '</p><strong>' + esc(value) + '</strong></li>').join('') +
        '</ul>';
      root.appendChild(metricSection);
      const memberSection = document.createElement('section');
      memberSection.setAttribute('aria-labelledby', 'member-management-title');
      memberSection.innerHTML = '<h2 id="member-management-title">Members &amp; access (' + members.length + ')</h2>' +
        '<p class="muted">Role changes are recorded in the append-only admin audit log. Deleted accounts are not shown.</p>' +
        '<ul class="cards">' + members.map((m) =>
          '<li class="card" data-member-card="' + esc(m.id) + '"><div class="meta"><strong>' + esc(m.name) +
          '</strong><span>' + esc(m.email || 'Email unavailable') + '</span><span>Member #' + esc(m.id) + '</span></div>' +
          '<div class="row-actions"><label><input type="checkbox" data-role-admin ' + (m.isAdmin ? 'checked' : '') +
          '> Administrator</label><label><input type="checkbox" data-role-verifier ' + (m.isVerifier ? 'checked' : '') +
          '> Verifier</label><button class="btn btn-secondary btn-sm" type="button" data-save-roles="' + esc(m.id) +
          '">Save access</button></div></li>').join('') + '</ul>';
      root.appendChild(memberSection);
      const auditSection = document.createElement('section');
      auditSection.setAttribute('aria-labelledby', 'audit-events-title');
      auditSection.innerHTML = '<h2 id="audit-events-title">Recent admin audit events</h2>' +
        (auditEvents.length ? '<ul class="list">' + auditEvents.map((e) =>
          '<li><strong>' + esc(e.eventType) + '</strong> · ' + esc(e.actorName) + ' → ' + esc(e.targetName) +
          '<span class="muted">' + esc(new Date(e.createdAt).toLocaleString()) + '</span><span class="muted">' +
          esc(JSON.stringify(e.beforeState)) + ' → ' + esc(JSON.stringify(e.afterState)) + '</span></li>').join('') + '</ul>'
          : '<p class="empty">No administrative changes have been recorded.</p>');
      root.appendChild(auditSection);
    }
    if (!root.dataset.resolveBound) {
      root.dataset.resolveBound = '1';
      root.addEventListener('click', async (event) => {
        const resolveButton = event.target.closest?.('[data-resolve-help]');
        const roleButton = event.target.closest?.('[data-save-roles]');
        const assignButton = event.target.closest?.('[data-assign-help]');
        if (!me?.isAdmin || (!resolveButton && !roleButton && !assignButton)) return;
        const button = resolveButton || roleButton || assignButton;
        button.disabled = true;
        try {
          if (resolveButton) {
            const id = resolveButton.getAttribute('data-resolve-help');
            await api('/admin/help-messages/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: {} });
            toast('Support message marked resolved.');
          } else if (assignButton) {
            const id=assignButton.getAttribute('data-assign-help');
            const select=root.querySelector('[data-assignee-for="' + CSS.escape(id) + '"]');
            await api('/admin/help-messages/' + encodeURIComponent(id) + '/assign', {method:'POST',body:{assigneeId:select?.value ? Number(select.value) : null}});
            toast('Support assignment updated and audited.');
          } else {
            const card = roleButton.closest('[data-member-card]');
            const id = roleButton.getAttribute('data-save-roles');
            const isAdmin = !!card?.querySelector('[data-role-admin]')?.checked;
            const isVerifier = !!card?.querySelector('[data-role-verifier]')?.checked;
            await api('/admin/members/' + encodeURIComponent(id) + '/roles', { method: 'PATCH', body: { isAdmin, isVerifier } });
            toast('Member access updated and audited.');
          }
          await renderWorkspace();
        } catch (err) {
          button.disabled = false;
          toast(err.message || 'Could not update this workspace record.');
        }
      });
    }
    $('#workspace-title')?.focus();
  }

  // ---- Welcome ----
  // The API sends null until each step is done (an absent field is treated as done).
  const needsWelcome = (u) => u.welcomedAt === null || u.termsAcceptedAt === null;
  function renderWelcome() {
    show('view-welcome');
    WelcomePage.render({
      me, root: $('#welcome'), toast,
      go: (h) => Router.go(h),
      onUser: (u) => { me = u; Nav.setUser(u); },
    });
  }

  // ---- Routing ----
  // Renderers only run for a signed-in member.
  // A member who has not finished the welcome flow is sent to #/welcome first.
  const guarded = (fn) => (...args) => {
    if (!me) return undefined;
    if (needsWelcome(me) && Router.current().name !== 'welcome') { Router.go('#/welcome'); return undefined; }
    return fn(...args);
  };
  async function renderHome() {
    show('view-home');
    try { await HomePage.render($('#home')); } catch (err) { $('#home').innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`; }
    $('#home-title')?.focus();
  }
  Router.register('home', guarded(renderHome));
  Router.register('feed', guarded(renderFeed)); // the older feed stays reachable at #/feed
  Router.register('new', guarded(renderNew));
  Router.register('requests', guarded(renderActivity));
  Router.register('request', guarded((id) => (id ? renderDetail(id) : renderActivity())));
  Router.register('circle', guarded(renderPeople));
  Router.register('profile', guarded((sub) => renderProfile(sub)));
  Router.register('workspace', guarded(renderWorkspace));
  Router.register('welcome', guarded(renderWelcome));
  let routerStarted = false;
  function route() {
    if (!me) return undefined;
    if (routerStarted) return Router.refresh();
    routerStarted = true;
    return Router.start();
  }

  // ---- Clerk sign-in ----
  async function boot() {
    let cfg;
    try { cfg = await fetch('/api/config').then((r) => r.json()); }
    catch (err) {
      // Offline: open from the last saved view. No sign-in widget is available without the network.
      try { await loadUsers(); route(); } catch { show('signed-out'); toast('You are offline.'); }
      return;
    }
    if (!cfg.clerkPublishableKey) { $('#auth-slot').textContent = 'Sign-in is not configured.'; show('signed-out'); return; }
    // Live keys reach Clerk through the same-origin proxy; development keys do not need it.
    const clerk = new window.Clerk(cfg.clerkPublishableKey, cfg.clerkProxyUrl ? { proxyUrl: cfg.clerkProxyUrl } : undefined);
    await clerk.load();
    clerkInstance = clerk;
    const mountAuth = () => {
      if (clerk.user) {
        clerk.mountUserButton(document.getElementById('auth-slot'));
      } else {
        $('#auth-slot').innerHTML = '<button class="btn btn-secondary" id="top-sign-in" type="button">Sign in</button>';
        $('#top-sign-in').addEventListener('click', () => clerk.openSignIn());
      }
    };
    // One refresh at a time. Clerk calls the listener as soon as it is added (and again on every sign-in
    // change), so overlapping calls are coalesced: a call that arrives while one is running schedules a single
    // re-run afterwards and shares its promise. /me is never fetched twice at once.
    let inFlight = null;
    let again = false;
    const refreshOnce = async () => {
      mountAuth();
      if (!clerk.user) { me = null; Api.clearSaved().catch(() => {}); show('signed-out'); return; }
      try { await loadUsers(); await route(); }
      catch (err) {
        if (err.code === 'invite_only') { me = null; show('view-not-invited'); return; }
        toast(err.message);
      }
    };
    const refresh = () => {
      if (inFlight) { again = true; return inFlight; }
      inFlight = (async () => {
        try { do { again = false; await refreshOnce(); } while (again); }
        finally { inFlight = null; }
      })();
      return inFlight;
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
