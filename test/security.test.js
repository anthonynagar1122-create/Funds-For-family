'use strict';
// Security sweep, grouped by category: input and injection, auth and access, secrets, configuration and hygiene.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createMemoryRepo } = require('../src/memory-repo');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-11-20T12:00:00Z');

async function setup() {
  const repo = createMemoryRepo();
  const sent = [];
  const logged = [];
  const app = createApp({
    repo,
    now: () => NOW,
    mailer: async (m) => { sent.push(m); },
    identify: async (req) => {
      const name = req.headers['x-test-user'];
      return name ? { clerkId: `clerk_${name}`, name, email: `${name}@example.com` } : null;
    },
    logger: { error: (...a) => logged.push(a) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (user, method, p, body, raw) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const payload = method === 'GET' ? undefined : (raw ?? (body ? JSON.stringify(body) : undefined));
    const r = await fetch(base + p, { method, headers, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, body: json, text };
  };
  const close = () => new Promise((res) => { server.close(res); server.closeAllConnections(); });
  return { repo, sent, logged, call, close, port: server.address().port };
}

const validRequest = (nomineeId, extra = {}) => ({
  amount: 500,
  purpose: 'School fees for the second term at the local college',
  repaymentDate: '2027-02-01',
  nomineeId,
  ...extra,
});

// ---------- Input validation and injection ----------

test('input: a purpose longer than 2000 characters is rejected', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const r = await s.call('ann', 'POST', '/requests', validRequest(nat.id, { purpose: 'x'.repeat(2001) }));
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'purpose');
  } finally { await s.close(); }
});

test('input: an amount above the storage ceiling is rejected (integer cents column)', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const r = await s.call('ann', 'POST', '/requests', validRequest(nat.id, { amount: 1e12 }));
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'amount');
  } finally { await s.close(); }
});

test('input: malformed JSON returns 400, not a server error', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const r = await s.call('ann', 'POST', '/requests', null, '{"amount": ');
    assert.equal(r.status, 400, `got ${r.status}`);
  } finally { await s.close(); }
});

test('input: an oversized JSON body is refused with 413', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const big = JSON.stringify({ purpose: 'x'.repeat(40000) });
    const r = await s.call('ann', 'POST', '/requests', null, big);
    assert.equal(r.status, 413, `got ${r.status}`);
  } finally { await s.close(); }
});

test('injection: a member name containing HTML is escaped in invitation email', async () => {
  const s = await setup();
  try {
    await s.call('<img src=x onerror=alert(1)>', 'GET', '/me');
    await s.call('<img src=x onerror=alert(1)>', 'POST', '/invites', { email: 'friend@example.com' });
    const html = s.sent[0].html;
    assert.doesNotMatch(html, /<img/, 'no raw tag in the email');
    assert.match(html, /&lt;img/);
  } finally { await s.close(); }
});

test('injection: a verifier note is stored and returned as data, not markup', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const vee = (await s.call('vee', 'GET', '/me')).body.user;
    const wes = (await s.call('wes', 'GET', '/me')).body.user;
    await s.repo.setVerifier(vee.id, true);
    await s.repo.setVerifier(wes.id, true);
    const id = (await s.call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;
    const note = '<script>alert(1)</script>';
    const r = await s.call('vee', 'POST', `/requests/${id}/verify`, { decision: 'approve', note });
    assert.equal(r.status, 200);
    assert.equal(r.body.request.verifications[0].note, note, 'returned as plain text for the client to escape');
  } finally { await s.close(); }
});

test('input: a non-numeric request id returns 404, not a crash', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const r = await s.call('ann', 'GET', '/requests/1%20OR%201=1');
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

// ---------- Authentication and access control ----------

test('auth: every protected endpoint refuses an anonymous caller', async () => {
  const s = await setup();
  try {
    const routes = [
      ['GET', '/me'], ['GET', '/users?q=ab'], ['GET', '/connections'], ['GET', '/feed'],
      ['POST', '/requests'], ['GET', '/requests/1'], ['POST', '/requests/1/verify'],
      ['POST', '/requests/1/contributions'], ['POST', '/requests/1/repayments'],
      ['POST', '/follows'], ['POST', '/invites'],
    ];
    for (const [m, p] of routes) {
      const r = await s.call(null, m, p, {});
      assert.equal(r.status, 401, `${m} ${p} returned ${r.status}`);
    }
  } finally { await s.close(); }
});

test('access: the borrower cannot verify their own request', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const ann = (await s.call('ann', 'GET', '/me')).body.user;
    await s.repo.setVerifier(ann.id, true);
    const id = (await s.call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;
    const r = await s.call('ann', 'POST', `/requests/${id}/verify`, { decision: 'approve' });
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('access: a stranger cannot record a repayment on someone else\'s loan', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const nat = (await s.call('nat', 'GET', '/me')).body.user;
    const id = (await s.call('ann', 'POST', '/requests', validRequest(nat.id))).body.request.id;
    const r = await s.call('zed', 'POST', `/requests/${id}/repayments`, { amount: 10 });
    // 404, not 403: outside the borrower's circle the request's existence is not revealed.
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

test('access: member search does not expose email addresses to other members', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    await s.call('ben', 'GET', '/me');
    const r = await s.call('ann', 'GET', '/users?q=ben');
    assert.equal(r.status, 200);
    for (const u of r.body.users) assert.equal(u.email, undefined, 'email hidden from other members');
  } finally { await s.close(); }
});

test('access: a member profile lookup does not expose another member\'s email', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    const ben = (await s.call('ben', 'GET', '/me')).body.user;
    const r = await s.call('ann', 'GET', `/users/${ben.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, undefined);
  } finally { await s.close(); }
});

test('access: a member sees their own email on their own profile', async () => {
  const s = await setup();
  try {
    const me = await s.call('ann', 'GET', '/me');
    assert.equal(me.body.user.email, 'ann@example.com');
  } finally { await s.close(); }
});

// ---------- Secrets and tokens ----------

test('secrets: no live keys or tokens are committed to the repository', () => {
  const skipDirs = new Set(['node_modules', '.git', 'data']);
  const patterns = [
    /sk_live_[A-Za-z0-9]{8,}/,
    /sk_test_[A-Za-z0-9]{8,}/,
    /re_[A-Za-z0-9]{20,}/,
    /eyJhbGciOi[A-Za-z0-9_-]{20,}/,
    /SUPABASE_SERVICE_ROLE_KEY=[^\s'"]{8,}/,
  ];
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(js|html|css|json|md|yml|yaml|txt|example)$/.test(name) || name.startsWith('.env')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(full);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});

test('secrets: environment files are git-ignored', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m);
});

test('secrets: the only Clerk key the browser receives is the publishable key', () => {
  const services = fs.readFileSync(path.join(ROOT, 'src', 'services.js'), 'utf8');
  const config = services.match(/root\.get\('\/api\/config'[\s\S]*?\);/)[0];
  assert.match(config, /clerkPublishableKey/);
  assert.doesNotMatch(config, /CLERK_SECRET_KEY|SERVICE_ROLE/);
});

// ---------- Configuration and hygiene ----------

test('hygiene: the framework fingerprint header is off', async () => {
  const s = await setup();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    assert.equal(r.headers.get('x-powered-by'), null);
  } finally { await s.close(); }
});

test('hygiene: a server failure returns a generic message and no stack trace', async () => {
  const s = await setup();
  try {
    await s.call('ann', 'GET', '/me');
    s.repo.listFeed = async () => { throw new Error('db secret detail: connection string leaked'); };
    const r = await s.call('ann', 'GET', '/feed');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Something went wrong');
    assert.doesNotMatch(r.text, /connection string|stack|at /i);
  } finally { await s.close(); }
});

test('hygiene: public folder contains no environment, git or source files', () => {
  const pub = fs.readdirSync(path.join(ROOT, 'public'));
  for (const name of pub) assert.doesNotMatch(name, /^\.env|^\.git|\.(js\.map|ts)$/);
});

test('headers: HSTS, clickjacking protection and a baseline CSP on every page', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const site = Object.fromEntries(cfg.headers
    .filter((h) => h.source === '/(.*)')
    .flatMap((h) => h.headers.map((x) => [x.key, x.value])));
  assert.match(site['Strict-Transport-Security'] || '', /max-age=\d{7,}/);
  assert.match(site['Strict-Transport-Security'] || '', /includeSubDomains/);
  assert.equal(site['X-Frame-Options'], 'DENY');
  // The app loads Clerk from its CDN, so script/connect sources are not locked down here.
  // These directives cannot break sign-in and still block plugins, <base> hijacking and framing.
  const csp = site['Content-Security-Policy'] || '';
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});
