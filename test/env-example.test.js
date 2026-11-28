'use strict';
// G-14: .env.example must list every environment variable the code reads, with placeholder values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('every process.env.X / env.X read in src/ and api/ is documented in .env.example', () => {
  const used = new Set();
  for (const f of [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'api'))]) {
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    for (const m of code.matchAll(/\b(?:process\.)?env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 10, `scan found only ${[...used]}`);
  const missing = [...used].filter((v) => !new RegExp(`^#?\\s*${v}=`, 'm').test(example));
  assert.deepEqual(missing, [], `undocumented variables: ${missing.join(', ')}`);
});

test('.env.example names the pilot switches and has no interest variable', () => {
  for (const v of ['OWNER_EMAIL', 'EMAIL_ENABLED', 'CRON_SECRET', 'APP_URL', 'RESEND_API_KEY', 'CLERK_SECRET_KEY', 'SUPABASE_URL']) {
    assert.match(example, new RegExp(`^#?\\s*${v}=`, 'm'), v);
  }
  assert.doesNotMatch(example, /INTEREST/i);
  assert.match(example, /^EMAIL_ENABLED=false$/m, 'EMAIL_ENABLED must default to false');
});

test('.env.example holds placeholders only (no real-looking secrets)', () => {
  assert.doesNotMatch(example, /(sk_live_|sk_test_[A-Za-z0-9]{10,}|pk_live_|re_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,})/);
});
