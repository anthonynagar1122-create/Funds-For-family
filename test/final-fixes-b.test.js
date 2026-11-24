'use strict';
// Fixes from the final whole-branch review of Phase B.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryRepo } = require('../src/memory-repo');
const { createSupabaseRepo } = require('../src/supabase-repo');
const { setup } = require('./helpers/harness');
const { idOf } = require('./helpers/lifecycle');

const root = path.join(__dirname, '..');

// ---- 1. checklist ----
test('the production checklist applies migration 0004 and checks the removed status', () => {
  const text = fs.readFileSync(path.join(root, 'docs/release/phase-a-production-checklist.md'), 'utf8');
  assert.match(text, /0004_removed_entry_status\.sql/);
  assert.match(text, /0005_delete_account_fn\.sql/);
  assert.ok(text.includes("select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('contributions_status_check','repayments_status_check')"));
  assert.match(text, /staging/i);
  assert.match(text, /contract suite/i);
});

// ---- 2. statement UTR rule ----
test('statement: a borrower does not see the UTR of a repayment made by the trusted contact; the contact sees their own', async () => {
  const s = await setup();
  try {
    const [bid, cid, lid] = [await idOf(s.call, 'bina'), await idOf(s.call, 'cara'), await idOf(s.call, 'lena')];
    const r = await s.repo.createRequest({ borrowerId: bid, trustedContactId: cid, purpose: 'School fees for the second term at college',
      category: 'education', principalCents: 50000, repaymentDate: '2026-12-01', status: 'funded', createdAt: '2026-10-01T00:00:00.000Z' });
    await s.repo.addContribution({ requestId: r.id, contributorId: lid, amountCents: 50000, status: 'confirmed', utr: '123456789012' });
    await s.repo.addRepayment({ requestId: r.id, payerId: bid, lenderId: lid, amountCents: 100, status: 'sent', utr: '111111111111' });
    await s.repo.addRepayment({ requestId: r.id, payerId: cid, lenderId: lid, amountCents: 200, status: 'sent', utr: '222222222222' });

    const b = await s.call('bina', 'GET', '/me/statement');
    const entries = b.body.requests[0].entries;
    assert.equal(entries.find((e) => e.kind === 'contribution').utr, '123456789012');
    assert.equal(entries.find((e) => e.kind === 'repayment' && e.amountCents === 100).utr, '111111111111');
    assert.equal(entries.find((e) => e.kind === 'repayment' && e.amountCents === 200).utr, null);
    assert.doesNotMatch(b.text, /222222222222/);

    const c = await s.call('cara', 'GET', '/me/statement');
    const mine = c.body.loans.flatMap((l) => l.entries).filter((e) => e.kind === 'repayment');
    assert.deepEqual(mine.map((e) => [e.amountCents, e.utr]), [[200, '222222222222']]);
    assert.doesNotMatch(c.text, /111111111111|123456789012/);

    const l = await s.call('lena', 'GET', '/me/statement');
    const lent = l.body.loans[0].entries.filter((e) => e.kind === 'repayment').map((e) => e.utr).sort();
    assert.deepEqual(lent, ['111111111111', '222222222222']);
  } finally { await s.close(); }
});

// ---- 3. delete account through one rpc ----
function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
    calls.push({ url: u.pathname, method: init.method || 'GET', body });
    return handler({ path: u.pathname, method: init.method || 'GET', body });
  };
  fn.calls = calls;
  return fn;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('Supabase deleteAccount makes one rpc call with the three arguments and no table writes', async () => {
  const row = { id: 7, clerk_id: 'deleted:7', name: 'Former member', email: 'deleted-7@deleted.invalid' };
  const f = recordingFetch(({ path: p }) => (p.endsWith('/rpc/delete_member_account') ? new Response(null, { status: 204 }) : json(row)));
  const repo = createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: f });
  const out = await repo.deleteAccount(7);
  const rpcs = f.calls.filter((c) => c.url.endsWith('/rpc/delete_member_account'));
  assert.equal(rpcs.length, 1);
  assert.deepEqual(rpcs[0].body, { p_user_id: 7, p_placeholder_email: 'deleted-7@deleted.invalid', p_clerk_placeholder: 'deleted:7' });
  assert.equal(f.calls.filter((c) => c.method !== 'GET' && !c.url.includes('/rpc/')).length, 0);
  assert.equal(out.id, 7);
});

test('Supabase deleteAccount surfaces an rpc error and returns null for an unknown member', async () => {
  const bad = recordingFetch(() => json({ code: '42501', message: 'permission denied', details: null }, 403));
  const repo = createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: bad });
  await assert.rejects(() => repo.deleteAccount(7), (e) => e.code === '42501' && /Supabase:/.test(e.message));
  const none = recordingFetch(({ path: p }) => (p.includes('/rpc/') ? new Response(null, { status: 204 }) : json(null)));
  assert.equal(await createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: none }).deleteAccount(7), null);
});

test('migration 0005 defines delete_member_account, locked to the service role', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0005_delete_account_fn.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.delete_member_account\(p_user_id bigint, p_placeholder_email text, p_clerk_placeholder text\)/i);
  assert.match(sql, /revoke execute on function public\.delete_member_account\(bigint, text, text\) from public, anon, authenticated/i);
  assert.match(sql, /is_admin = false/i);
  assert.match(sql, /is_verifier = false/i);
});

// ---- 4. resolveHelpMessage error ----
test('Supabase resolveHelpMessage throws when the update fails', async () => {
  const f = recordingFetch(({ method }) => (method === 'PATCH' ? json({ code: '500', message: 'boom', details: null }, 500) : json(null)));
  const repo = createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: f });
  await assert.rejects(() => repo.resolveHelpMessage(3, '2026-11-24T00:00:00.000Z'), /Supabase: boom/);
});

// ---- 5. deleted members lose admin and verifier ----
test('memory deleteAccount clears is_admin and is_verifier', async () => {
  const repo = createMemoryRepo();
  const u = await repo.createUser({ clerkId: 'c1', name: 'Ola', email: 'ola@x.test', isAdmin: true, isVerifier: true });
  const out = await repo.deleteAccount(u.id);
  assert.equal(out.isAdmin, false);
  assert.equal(out.isVerifier, false);
  const again = await repo.getUser(u.id);
  assert.equal(again.isAdmin, false);
  assert.equal(again.isVerifier, false);
});
