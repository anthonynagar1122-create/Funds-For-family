(() => {
  'use strict';
  const esc = (window.Format && window.Format.esc) || ((s) => String(s ?? ''));

  // Hash router. Hashes look like #/home, #/request/12. The older #feed, #people, #activity still work.
  const ALIASES = { '': 'home', people: 'circle', activity: 'requests', request: 'request', admin: 'workspace' };
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

  const TAB_FOR = { home: 'home', feed: 'discover', request: 'activity', requests: 'activity', new: 'new', circle: 'circle', profile: 'profile', help: 'profile', workspace: 'workspace' };
  const MEMBER_TABS = [
    { id: 'home', label: 'Home' },
    { id: 'discover', label: 'Discover' },
    { id: 'activity', label: 'Activity' },
    { id: 'new', label: '+ New', cls: 'tab-new' },
    { id: 'circle', label: 'Circle' },
    { id: 'profile', label: 'Profile' },
  ];

  function renderNav(me, route = current) {
    const nav = document.getElementById('primary-nav');
    if (!nav) return;
    const tabs = [...MEMBER_TABS];
    if (me && (me.isAdmin === true || me.isVerifier === true)) tabs.push({ id: 'workspace', label: me.isAdmin ? 'Admin' : 'Verify', cls: 'tab-workspace' });
    const active = TAB_FOR[route.name];
    nav.hidden = !me || me.welcomedAt === null || me.termsAcceptedAt === null;
    nav.innerHTML = tabs.map((t) => {
      const href = t.id === 'discover' ? '#/feed' : t.id === 'activity' ? '#/requests' : '#/' + t.id;
      return `<a class="tab ${t.cls || ''}" id="nav-${esc(t.id)}" href="${href}"${t.id === active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`;
    }).join('');
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
