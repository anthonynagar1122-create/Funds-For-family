'use strict';
// Environment configuration: key selection, missing variables, preview isolation, and secret isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../src/config');

const ROOT = path.join(__dirname, '..');
const PRODUCTION_REF = 'enqxchwiqfdqwrvuqlph';
const STAGING_REF = 'stagingref0000000000';
const SECRET = 'sb_secret_TESTVALUE_0123456789';
const LEGACY = 'legacy_service_role_TESTVALUE_0123456789';

test('the secret key is preferred over the legacy service-role name', () => {
  const r = cfg.resolveSupabaseKey({ SUPABASE_SECRET_KEY: SECRET, SUPABASE_SERVICE_ROLE_KEY: LEGACY });
  assert.equal(r.value, SECRET);
  assert.equal(r.source, 'SUPABASE_SECRET_KEY');
});

test('the legacy service-role name works when the secret key is absent', () => {
  const r = cfg.resolveSupabaseKey({ SUPABASE_SERVICE_ROLE_KEY: LEGACY });
  assert.equal(r.value, LEGACY);
  assert.equal(r.source, 'SUPABASE_SERVICE_ROLE_KEY');
});

test('a missing Supabase key is reported by name, and the message holds no value', () => {
  const problems = cfg.validateServerConfig({ SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x' });
  const text = problems.join('\n');
  assert.match(text, /SUPABASE_SECRET_KEY/);
  assert.match(text, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('missing required variables are all listed at once', () => {
  const problems = cfg.validateServerConfig({});
  const text = problems.join('\n');
  for (const name of ['SUPABASE_URL', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) assert.match(text, new RegExp(name));
});

test('no problem message ever contains a secret value', () => {
  const problems = cfg.validateServerConfig({ SUPABASE_URL: 'not a url', SUPABASE_SECRET_KEY: SECRET, CLERK_SECRET_KEY: '' });
  for (const p of problems) assert.doesNotMatch(p, /TESTVALUE/);
});

test('a complete server configuration has no problems', () => {
  const problems = cfg.validateServerConfig({
    SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, SUPABASE_SECRET_KEY: SECRET,
    CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: 'sk_test_x',
  });
  assert.deepEqual(problems, []);
});

test('preview must not use the production database', () => {
  const problems = cfg.isolationProblems({ VERCEL_ENV: 'preview', SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /production database/);
});

test('preview may use the staging database', () => {
  assert.deepEqual(cfg.isolationProblems({ VERCEL_ENV: 'preview', SUPABASE_URL: `https://${STAGING_REF}.supabase.co` }), []);
});

test('production may use the production database', () => {
  assert.deepEqual(cfg.isolationProblems({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }), []);
});

test('no server secret name or key literal appears in the browser folder', () => {
  const names = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLERK_SECRET_KEY', 'RESEND_API_KEY', 'sb_secret_', 'eyJhbGciOi'];
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else { const text = fs.readFileSync(full, 'utf8'); for (const n of names) if (text.includes(n)) hits.push(`${full}: ${n}`); }
    }
  };
  walk(path.join(ROOT, 'public'));
  assert.deepEqual(hits, []);
});

test('the environment template holds placeholders only and names the preferred key', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^SUPABASE_SECRET_KEY=/m);
  assert.doesNotMatch(env, /sb_secret_[A-Za-z0-9]/);
  assert.doesNotMatch(env, /sk_live_|sk_test_[A-Za-z0-9]{6,}/);
});

test('the production entry point refuses to start with incomplete configuration', () => {
  const { buildProductionApp } = require('../src/services');
  assert.throws(() => buildProductionApp({}), /CLERK_PUBLISHABLE_KEY/, 'reports every missing name, not just the first');
});

test('an uppercase production reference is still blocked in preview', () => {
  const problems = cfg.isolationProblems({ VERCEL_ENV: 'preview', SUPABASE_URL: 'https://ENQXCHWIQFDQWRVUQLPH.supabase.co' });
  assert.equal(problems.length, 1);
});

test('a production reference hidden in any other host form is still blocked in preview', () => {
  const problems = cfg.isolationProblems({ VERCEL_ENV: 'preview', SUPABASE_URL: 'https://enqxchwiqfdqwrvuqlph.supabase.co.example.net' });
  assert.equal(problems.length, 1);
});
