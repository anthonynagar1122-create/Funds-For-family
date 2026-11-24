(() => {
  'use strict';
  const esc = (window.Format && window.Format.esc) || ((s) => String(s ?? ''));

  // Hash router. Hashes look like #/home, #/request/12. The older #feed, #people, #activity still work.
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
    const target = h.startsWith('#') ? h : '#/' + h; // a leading # is kept as given
    if (location.hash === target) return dispatch();
    location.hash = target; // hashchange triggers dispatch
    return undefined;
  }

  // Which tab is lit for each route.
  const TAB_FOR = { home: 'home', feed: 'home', request: 'requests', requests: 'requests', new: 'new', circle: 'circle', profile: 'profile', help: 'profile', terms: 'profile', privacy: 'profile', admin: 'admin' };
  const TABS = [
    { id: 'home', label: 'Home' },
    { id: 'requests', label: 'Requests' },
    { id: 'new', label: '+ New', cls: 'tab-new' },
    { id: 'circle', label: 'Circle' },
    { id: 'profile', label: 'Profile' },
  ];

  // Renders into <nav id="primary-nav">. The same markup is a top bar above 768px and a bottom tab bar below it (CSS).
  function renderNav(me, route = current) {
    const nav = document.getElementById('primary-nav');
    if (!nav) return;
    const tabs = me && me.isAdmin === true ? [...TABS, { id: 'admin', label: 'Admin' }] : TABS;
    const active = TAB_FOR[route.name];
    // The welcome flow is a focused screen: no navigation until it is finished.
    nav.hidden = !me || me.welcomedAt === null || me.termsAcceptedAt === null;
    nav.innerHTML = tabs.map((t) => `<a class="tab ${t.cls || ''}" id="nav-${esc(t.id)}" href="#/${esc(t.id)}"${t.id === active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('');
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
