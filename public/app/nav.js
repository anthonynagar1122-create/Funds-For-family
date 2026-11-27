(() => {
  'use strict';
  const esc = (window.Format && window.Format.esc) || ((s) => String(s ?? ''));

  // Hash router. Hashes look like #/home, #/request/12. The older #feed, #people, #activity still work.
  // #/admin is the owner admin page (invites, limits, stuck payments, gaps, stats); #/workspace is the role-aware
  // Admin/Verify workspace. Both light the same workspace entry.
  const ALIASES = { '': 'home', people: 'circle', activity: 'requests', request: 'request' };
  const renderers = new Map();
  let current = { name: 'home', params: [] };
  let onChange = null;

  function parse(hash) {
    const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';
    const name = ALIASES[head] ?? head;
    if (!renderers.has(name)) return { name: 'home', params: [] };
    return { name, params: parts.slice(1) };
  }

  function register(name, renderFn) { renderers.set(name, renderFn); }

  async function dispatch() {
    current = parse(location.hash);
    if (onChange) onChange(current);
    return renderers.get(current.name)(...current.params);
  }

  function go(hash) {
    const h = String(hash);
    const target = h.startsWith('#') ? h : '#/' + h;
    if (location.hash === target) return dispatch();
    location.hash = target;
    return undefined;
  }

  // Which entry is lit for each route. Five member tabs at every width (the 44 px rule at 320 px, P-45 merge):
  // Home, Requests (the circle feed of mutual connections' open requests plus my activity; closes G-06), + New,
  // Circle, Profile. Admins and verifiers also get ONE role-labelled workspace entry ("Admin" or "Verify") that sits in
  // the top bar, outside the bottom tab bar, so the tab bar never holds more than five targets.
  const TAB_FOR = { home: 'home', feed: 'requests', request: 'requests', requests: 'requests', new: 'new', circle: 'circle',
    profile: 'profile', help: 'profile', terms: 'profile', privacy: 'profile', workspace: 'workspace', admin: 'workspace' };
  const MEMBER_TABS = [
    { id: 'home', label: 'Home' },
    { id: 'requests', label: 'Requests' },
    { id: 'new', label: '+ New', cls: 'tab-new' },
    { id: 'circle', label: 'Circle' },
    { id: 'profile', label: 'Profile' },
  ];

  // Renders into <nav id="primary-nav">. The same markup is a top bar above 768px and a bottom tab bar below it (CSS).
  // The role entry renders into #workspace-slot in the header (server-confirmed roles still guard every API call).
  function renderNav(me, route = current) {
    const nav = document.getElementById('primary-nav');
    if (!nav) return;
    const active = TAB_FOR[route.name];
    // The welcome flow is a focused screen: no navigation until it is finished.
    const hidden = !me || me.welcomedAt === null || me.termsAcceptedAt === null;
    nav.hidden = hidden;
    nav.innerHTML = MEMBER_TABS.map((t) => `<a class="tab ${t.cls || ''}" id="nav-${esc(t.id)}" href="#/${esc(t.id)}"${t.id === active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('');
    const slot = document.getElementById('workspace-slot');
    if (!slot) return;
    const role = !hidden && me && (me.isAdmin === true || me.isVerifier === true);
    slot.hidden = !role;
    slot.innerHTML = role
      ? `<a class="tab tab-workspace" id="nav-workspace" href="#/workspace"${active === 'workspace' ? ' aria-current="page"' : ''}>${esc(me.isAdmin === true ? 'Admin' : 'Verify')}</a>`
      : '';
  }

  let navMe = null;
  function setUser(me) { navMe = me; renderNav(me); }
  function start() {
    onChange = (route) => renderNav(navMe, route);
    window.addEventListener('hashchange', dispatch);
    return dispatch();
  }

  window.Router = { go, register, start, refresh: dispatch, parse, current: () => current };
  window.Nav = { render: renderNav, setUser };
})();
