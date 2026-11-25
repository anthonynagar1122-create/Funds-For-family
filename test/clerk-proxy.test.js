'use strict';
// Clerk Frontend API proxy: the browser is told to use the proxy only for live keys; no secret ever reaches the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductionApp } = require('../src/services');

const SECRET = 'clerk-secret-test-only-value';
const base = (clerkPk) => ({
  SUPABASE_URL: 'https://stagingref0000000000.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_TESTVALUE_0123456789',
  CLERK_PUBLISHABLE_KEY: clerkPk,
  CLERK_SECRET_KEY: SECRET,
  VERCEL_ENV: 'production',
});

async function configFrom(env) {
  const app = buildProductionApp(env);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
    return { status: r.status, text: await r.text() };
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('a live key tells the browser to use the Clerk proxy path', async () => {
  const r = await configFrom(base('pk_live_Y2xlcmsuZnVuZHMtZm9yLWZhbWlseS52ZXJjZWwuYXBwJA'));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).clerkProxyUrl, '/__clerk');
});

test('a development key does not use the proxy', async () => {
  const r = await configFrom(base('pk_test_ZW5vdWdoLWJlZS02ODg0LmNsZXJrLmFjY291bnRzLmRldiQ'));
  assert.equal(JSON.parse(r.text).clerkProxyUrl, null);
});

test('the config response never contains the Clerk secret key', async () => {
  const r = await configFrom(base('pk_live_Y2xlcmsuZnVuZHMtZm9yLWZhbWlseS52ZXJjZWwuYXBwJA'));
  assert.doesNotMatch(r.text, /clerk-secret-test-only-value/);
});

test('the browser Clerk object is created with the proxy URL from the config endpoint', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /new window\.Clerk\(cfg\.clerkPublishableKey, cfg\.clerkProxyUrl \? \{ proxyUrl: cfg\.clerkProxyUrl \} : undefined\)/);
});
