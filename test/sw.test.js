'use strict';
// Static checks on public/sw.js: the cache policy must stay narrow (Phase B Review Focus 3 and 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function load() {
  const listeners = {};
  const sandbox = { self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'http://x.test' }, skipWaiting() {}, clients: { claim() {} } }, caches: {}, URL, Response, Headers, console };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;this.__exports = { CACHE_VERSION, SHELL_FILES, API_ALLOW, API_DENY_PREFIXES, shouldHandle };`, sandbox);
  return { ...sandbox.__exports, listeners };
}

test('sw.js declares a versioned cache', () => {
  const { CACHE_VERSION } = load();
  assert.match(String(CACHE_VERSION), /\S/);
  assert.match(src, /caches\.keys\(\)/, 'old caches are enumerated on activate');
  assert.match(src, /caches\.delete\(/, 'old caches are deleted');
});

test('API allow-list is exactly home, feed, me, activity', () => {
  const { API_ALLOW } = load();
  assert.deepEqual([...API_ALLOW].sort(), ['/api/activity', '/api/feed', '/api/home', '/api/me']);
});

test('deny-list covers admin and invites', () => {
  const { API_DENY_PREFIXES } = load();
  assert.ok(API_DENY_PREFIXES.includes('/api/admin'));
  assert.ok(API_DENY_PREFIXES.includes('/api/invites'));
});

test('shell list covers app page, styles, scripts and icons', () => {
  const { SHELL_FILES } = load();
  for (const f of ['/app/', '/styles.css', '/app.js', '/app/api.js', '/app/nav.js', '/icons/icon-192.png', '/icons/icon-512.png']) {
    assert.ok(SHELL_FILES.includes(f), `${f} in shell`);
  }
  for (const f of SHELL_FILES) assert.ok(!f.startsWith('/api/'), 'no API path in the shell list');
});

test('shouldHandle: only GET; never mutations, admin, invites or token-bearing requests', () => {
  const { shouldHandle } = load();
  const req = (method, url, headers = {}) => ({ method, url: `http://x.test${url}`, headers: new Headers(headers) });
  assert.equal(shouldHandle(req('GET', '/api/feed')).kind, 'api');
  assert.equal(shouldHandle(req('GET', '/api/home')).kind, 'api');
  assert.equal(shouldHandle(req('GET', '/app/nav.js')).kind, 'shell');
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(shouldHandle(req(m, '/api/feed')), null, `${m} /api/feed`);
    assert.equal(shouldHandle(req(m, '/app/')), null, `${m} /app/`);
  }
  assert.equal(shouldHandle(req('GET', '/api/admin/users')), null);
  assert.equal(shouldHandle(req('GET', '/api/admin')), null);
  assert.equal(shouldHandle(req('GET', '/api/invites')), null);
  assert.equal(shouldHandle(req('GET', '/api/invites/abc')), null);
  assert.equal(shouldHandle(req('GET', '/api/requests/5')), null, 'not on the allow-list');
  assert.equal(shouldHandle(req('GET', '/api/me', { 'x-invite-token': 'tok' })), null, 'token requests are never cached');
  assert.equal(shouldHandle(req('GET', '/api/feed?join=tok')), null, 'unexpected query strings on API are not cached');
  assert.equal(shouldHandle(req('GET', '/other')), null);
});

test('source never caches POST or admin paths', () => {
  assert.doesNotMatch(src, /method\s*===\s*['"]POST['"]/);
  const putCalls = src.match(/cache\.put\(/g) || [];
  assert.ok(putCalls.length >= 1);
  assert.match(src, /x-from-sw-cache/);
});
