(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const money = (cents) => Money.formatInr(cents);
  const esc = Format.esc;
  const views = ['signed-out', 'view-home', 'view-feed', 'view-new', 'view-not-invited', 'view-detail', 'view-circle', 'view-activity', 'view-profile', 'view-welcome', 'view-admin'];
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
    if (!Api.fromCache) Api.setSavedUser(user.id); // only a live answer says who is signed in
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

  // ---- Admin (owner only; the API enforces it too) ----
  async function renderAdmin() {
    if (!me?.isAdmin) { Router.go('#/home'); return; }
    show('view-admin');
    try { await AdminPage.render($('#admin')); } catch (err) { $('#admin').innerHTML = `<p class="error" role="alert">Could not load this page. ${esc(err.message)}</p>`; }
    $('#admin-heading')?.focus();
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
  Router.register('welcome', guarded(renderWelcome));
  Router.register('admin', guarded(renderAdmin));
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
      try { await loadUsers(); route(); } catch (e) { show('signed-out'); toast(e.code === 'saved_view_mismatch' ? e.message : 'You are offline.'); }
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
