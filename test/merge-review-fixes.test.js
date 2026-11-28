'use strict';
// Review findings on the P-45 combined branch (docs/production-readiness/06-merge-review-fixes.md):
//   I-1 an idempotent retry replays the saved entry instead of tripping the UTR/cap pre-checks;
//   I-2 owner settlement writes through a locked, atomic repo call (settle_contribution / settle_repayment RPCs);
//   minor: removed rows release their UTR, delete_member_account clears help assignments, operations counts use a
//   count query, checklist wording, the 0010 comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers/harness');
const { createSupabaseRepo } = require('../src/supabase-repo');
const { startRequest, connect, idOf, lend } = require('./helpers/lifecycle');

const root = path.join(__dirname, '..');
const BOSS = { 'x-test-email': 'boss@example.com' };

async function adminSetup(opts = {}) {
  const s = await setup({ ownerEmail: 'boss@example.com', ...opts });
  await s.call('boss', 'GET', '/me', null, null, BOSS);
  const admin = (method, p, body) => s.call('boss', method, `/admin${p}`, body, null, BOSS);
  return { s, admin };
}

// A request open for funding (principal 500 rupees) with `lender` connected to the borrower.
async function openRequest(s, { borrower = 'bo', contact = 'cy', lender = 'li' } = {}) {
  const id = await startRequest(s.call, borrower, contact);
  for (const v of ['v1', 'v2']) {
    await s.call(v, 'GET', '/me');
    await s.repo.setVerifier(await idOf(s.call, v), true);
    await s.call(v, 'POST', `/requests/${id}/verify`, { decision: 'approve' });
  }
  await connect(s.call, borrower, lender);
  return id;
}

const keyed = (key) => ({ 'idempotency-key': key });

// ---- I-1: idempotent retries replay ----
test('I-1 contribution: a retry with the same key and body replays the saved entry, even with a UTR and a full cap', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    const body = { amount: 500, utr: 'RETRYUTR0001' };
    const first = await s.call('li', 'POST', `/requests/${id}/contributions`, body, undefined, keyed('contrib-retry-0001'));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    s.sent.length = 0;
    const again = await s.call('li', 'POST', `/requests/${id}/contributions`, body, undefined, keyed('contrib-retry-0001'));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.contribution.id, first.body.contribution.id);
    assert.equal(again.body.contribution.utr, 'RETRYUTR0001');
    assert.equal(s.sent.length, 0, 'a replay sends no second email');
    assert.equal((await s.repo.listContributions(id)).length, 1, 'no second row');
    // After the borrower confirms, the request is funded and the cap is full: the retry still replays.
    await s.call('bo', 'POST', `/contributions/${first.body.contribution.id}/confirm`);
    const late = await s.call('li', 'POST', `/requests/${id}/contributions`, body, undefined, keyed('contrib-retry-0001'));
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal(late.body.contribution.id, first.body.contribution.id);
  } finally { await s.close(); }
});

test('I-1 contribution: the same key with a different body is still refused', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    const first = await s.call('li', 'POST', `/requests/${id}/contributions`, { amount: 100, utr: 'RETRYUTR0002' }, undefined, keyed('contrib-retry-0002'));
    assert.equal(first.status, 201);
    for (const body of [{ amount: 120, utr: 'RETRYUTR0002' }, { amount: 100, utr: 'OTHERUTR0002' }, { amount: 100, utr: '' }]) {
      const r = await s.call('li', 'POST', `/requests/${id}/contributions`, body, undefined, keyed('contrib-retry-0002'));
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.match(r.body.error, /idempotency key was already used for a different contribution/);
    }
    assert.equal((await s.repo.listContributions(id)).length, 1);
  } finally { await s.close(); }
});

test('I-1 repayment: a retry replays the saved entry with a UTR, with the cap full and after the request is repaid', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    await lend(s.call, 'li', 'bo', id, 500, { confirm: true });
    const lenderId = await idOf(s.call, 'li');
    const body = { lenderId, amount: 500, utr: 'REPAYUTR0001' };
    const first = await s.call('bo', 'POST', `/requests/${id}/repayments`, body, undefined, keyed('repay-retry-0001'));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await s.call('bo', 'POST', `/requests/${id}/repayments`, body, undefined, keyed('repay-retry-0001'));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.repayment.id, first.body.repayment.id);
    await s.call('li', 'POST', `/repayments/${first.body.repayment.id}/confirm`);
    assert.equal((await s.repo.getRequest(id)).status, 'repaid');
    const late = await s.call('bo', 'POST', `/requests/${id}/repayments`, body, undefined, keyed('repay-retry-0001'));
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal(late.body.repayment.id, first.body.repayment.id);
    const diff = await s.call('bo', 'POST', `/requests/${id}/repayments`, { ...body, amount: 400 }, undefined, keyed('repay-retry-0001'));
    assert.equal(diff.status, 409);
    assert.match(diff.body.error, /idempotency key was already used for a different repayment/);
    assert.equal((await s.repo.listRepayments(id)).length, 1);
  } finally { await s.close(); }
});

test('I-1: without an Idempotency-Key a repeated UTR is still refused', async () => {
  const s = await setup();
  try {
    const id = await openRequest(s);
    const body = { amount: 100, utr: 'NOKEYUTR001' };
    assert.equal((await s.call('li', 'POST', `/requests/${id}/contributions`, body)).status, 201);
    const r = await s.call('li', 'POST', `/requests/${id}/contributions`, body);
    assert.equal(r.status, 409);
    assert.equal(r.body.field, 'utr');
  } finally { await s.close(); }
});

// ---- I-2: owner settle goes through the locked repo call ----
test('I-2 settle routes write through repo.settleContribution / settleRepayment, never a plain update', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openRequest(s);
    const cid = await lend(s.call, 'li', 'bo', id, 500, { confirm: false });
    const calls = [];
    const realSettle = s.repo.settleContribution;
    const realUpdate = s.repo.updateContribution;
    s.repo.settleContribution = async (args) => { calls.push(args); return realSettle(args); };
    s.repo.updateContribution = async () => { throw new Error('plain update must not be used by settle'); };
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const ok = await admin('POST', `/contributions/${cid}/settle`, { action: 'confirm', note: 'Borrower confirmed by phone' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    s.repo.updateContribution = realUpdate;
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], at: undefined }, { entryId: cid, actorId: await idOf(s.call, 'boss'), action: 'confirm',
      note: 'Borrower confirmed by phone', at: undefined });
    assert.equal((await s.repo.getRequest(id)).status, 'funded', 'the app still recomputes the request');
  } finally { await s.close(); }
});

test('I-2 settle routes map settle errors: 42501 -> 403, P0002 -> 404, 23514 and 55000 -> 409', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openRequest(s);
    const cid = await lend(s.call, 'li', 'bo', id, 100, { confirm: false });
    const id2 = await openRequest(s, { borrower: 'bb', contact: 'cc', lender: 'll' });
    await lend(s.call, 'll', 'bb', id2, 500, { confirm: true });
    const paid = await s.call('bb', 'POST', `/requests/${id2}/repayments`, { lenderId: await idOf(s.call, 'll'), amount: 100 });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const pid = paid.body.repayment.id;
    s.setNow(new Date('2026-12-01T12:00:00Z'));
    for (const [code, status] of [['42501', 403], ['P0002', 404], ['23514', 409], ['55000', 409]]) {
      const boom = async () => { throw Object.assign(new Error(`Supabase: refused ${code}`), { code }); };
      s.repo.settleContribution = boom;
      s.repo.settleRepayment = boom;
      const c = await admin('POST', `/contributions/${cid}/settle`, { action: 'remove', note: 'a valid note' });
      assert.equal(c.status, status, `contribution ${code}`);
      assert.equal(typeof c.body.error, 'string');
      const p = await admin('POST', `/repayments/${pid}/settle`, { action: 'remove', note: 'a valid note' });
      assert.equal(p.status, status, `repayment ${code}`);
    }
  } finally { await s.close(); }
});

// ---- Minor: removed rows release their UTR ----
test('a UTR from an entry the owner removed can be used again on the same request', async () => {
  const { s, admin } = await adminSetup();
  try {
    const id = await openRequest(s);
    const first = await s.call('li', 'POST', `/requests/${id}/contributions`, { amount: 100, utr: 'REUSEUTR001' });
    assert.equal(first.status, 201);
    s.setNow(new Date('2026-11-28T12:00:00Z'));
    const removed = await admin('POST', `/contributions/${first.body.contribution.id}/settle`, { action: 'remove', note: 'Lender says it never went' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const again = await s.call('li', 'POST', `/requests/${id}/contributions`, { amount: 100, utr: 'reuseutr001' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  } finally { await s.close(); }
});

// ---- Minor: operations counts are not capped by the 200-row list ----
test('/admin/operations counts every active member, not just the first 200 rows', async () => {
  const { s, admin } = await adminSetup();
  try {
    for (let i = 0; i < 205; i++) await s.repo.createUser({ clerkId: `bulk_${i}`, name: `Bulk ${i}`, email: `bulk${i}@x.test`, isVerifier: i < 3 });
    const r = await admin('GET', '/operations');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.metrics.members, 206, 'boss plus 205');
    assert.equal(r.body.metrics.admins, 1);
    assert.equal(r.body.metrics.verifiers, 4, 'boss plus 3');
  } finally { await s.close(); }
});

// ---- Supabase repo wiring (fake fetch; no database) ----
function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    calls.push({ url: u.pathname, query: u.search, method: init.method || 'GET', body, headers });
    return handler({ path: u.pathname, query: u.search, method: init.method || 'GET', body });
  };
  fn.calls = calls;
  return fn;
}
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const sb = (f) => createSupabaseRepo({ url: 'http://127.0.0.1:1', serviceRoleKey: 'k', fetch: f });

test('Supabase settleContribution / settleRepayment call their RPCs with the five arguments and map the row', async () => {
  const row = { id: 9, request_id: 3, contributor_id: 4, payer_id: 5, lender_id: 6, amount_cents: 100, status: 'confirmed', settled_by: 1, settled_note: 'ok note' };
  const f = recordingFetch(() => json(row));
  const repo = sb(f);
  const at = '2026-12-01T10:00:00.000Z';
  const c = await repo.settleContribution({ entryId: 9, actorId: 1, action: 'confirm', note: 'ok note', at });
  const p = await repo.settleRepayment({ entryId: 9, actorId: 1, action: 'remove', note: 'ok note', at });
  assert.equal(f.calls[0].url, '/rest/v1/rpc/settle_contribution');
  assert.deepEqual(f.calls[0].body, { p_entry_id: 9, p_actor_id: 1, p_action: 'confirm', p_note: 'ok note', p_at: at });
  assert.equal(f.calls[1].url, '/rest/v1/rpc/settle_repayment');
  assert.deepEqual(f.calls[1].body, { p_entry_id: 9, p_actor_id: 1, p_action: 'remove', p_note: 'ok note', p_at: at });
  assert.equal(c.contributorId, 4);
  assert.equal(c.settledBy, 1);
  assert.equal(p.lenderId, 6);
  assert.equal(f.calls.filter((x) => !x.url.includes('/rpc/')).length, 0, 'no table writes');
  const bad = sb(recordingFetch(() => json({ code: '23514', message: 'Only 0 paise is still needed', details: null }, 400)));
  await assert.rejects(() => bad.settleContribution({ entryId: 9, actorId: 1, action: 'confirm', note: 'ok note', at }), (e) => e.code === '23514');
});

test('Supabase findIdempotentEntry reads the saved response by operation, actor and key', async () => {
  const f = recordingFetch(() => json({ response: { id: 12, request_id: 3, contributor_id: 4, amount_cents: 100, utr: 'ABC123456', status: 'sent' } }));
  const out = await sb(f).findIdempotentEntry({ operation: 'contribution.create', actorId: 4, idempotencyKey: 'key-12345678' });
  assert.equal(out.id, 12);
  assert.equal(out.contributorId, 4);
  assert.equal(f.calls[0].url, '/rest/v1/financial_idempotency');
  for (const part of ['operation=eq.contribution.create', 'actor_id=eq.4', 'idempotency_key=eq.key-12345678']) assert.ok(f.calls[0].query.includes(part), part);
  assert.equal(await sb(recordingFetch(() => json(null))).findIdempotentEntry({ operation: 'repayment.create', actorId: 4, idempotencyKey: 'key-12345678' }), null);
  assert.equal(await sb(recordingFetch(() => json({ response: null }))).findIdempotentEntry({ operation: 'repayment.create', actorId: 4, idempotencyKey: 'key-12345678' }), null, 'still in flight');
});

test('Supabase countUsers uses an exact head count, filtered by role and active members', async () => {
  const f = recordingFetch(() => new Response(null, { status: 200, headers: { 'content-range': '*/321' } }));
  const repo = sb(f);
  assert.equal(await repo.countUsers(), 321);
  assert.equal(await repo.countUsers({ role: 'admin' }), 321);
  assert.equal(await repo.countUsers({ role: 'verifier' }), 321);
  assert.ok(f.calls.every((c) => c.method === 'HEAD' && c.query.includes('deleted_at=is.null')));
  assert.ok(f.calls[1].query.includes('is_admin=eq.true'));
  assert.ok(f.calls[2].query.includes('is_verifier=eq.true'));
  assert.ok(f.calls.every((c) => /count=exact/.test(c.headers.prefer || '')));
});

// ---- Migrations and docs ----
const readMig = (name) => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8').toLowerCase();

test('migration 0012 defines locked settle RPCs, service-role only, and UTR indexes that skip removed rows', () => {
  const sql = readMig('0012_settle_entry_rpc.sql');
  assert.match(sql, /^\s*(--[^\n]*\n\s*)*begin;/);
  assert.match(sql, /commit;\s*$/);
  for (const fn of ['settle_contribution', 'settle_repayment']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(\\s*p_entry_id bigint,\\s*p_actor_id bigint,\\s*p_action text,\\s*p_note text,\\s*p_at timestamptz`));
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\(bigint, bigint, text, text, timestamptz\\) from public, anon, authenticated`));
  }
  assert.equal((sql.match(/from public\.requests where id\s*=\s*v_request_id for update/g) || []).length, 2, 'both lock the request row');
  for (const code of ['23514', '42501', 'p0002', '55000']) assert.ok(sql.includes(`errcode = '${code}'`), code);
  assert.ok(!/delete from public\.(contributions|repayments)/.test(sql), 'remove never deletes');
  for (const idx of ['contributions_request_utr_key', 'repayments_request_utr_key']) {
    assert.match(sql, new RegExp(`drop index if exists public\\.${idx}`));
    assert.match(sql, new RegExp(`create unique index if not exists ${idx}[\\s\\S]*?where utr is not null and status <> 'removed'`));
  }
});

test('migration 0013 replaces delete_member_account and clears help-message assignments', () => {
  const sql = readMig('0013_delete_account_cleanup.sql');
  assert.match(sql, /create or replace function public\.delete_member_account\(p_user_id bigint, p_placeholder_email text, p_clerk_placeholder text\)/);
  assert.match(sql, /update public\.help_messages set assigned_to = null where assigned_to = p_user_id/);
  assert.match(sql, /revoke execute on function public\.delete_member_account\(bigint, text, text\) from public, anon, authenticated/);
  for (const k of ['is_admin = false', 'is_verifier = false', 'delete from public.follows']) assert.ok(sql.includes(k), k);
});

test('the production checklist does not call 0007 a single transaction and lists 0012 and 0013 in order', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/release/phase-a-production-checklist.md'), 'utf8');
  const line = doc.split('\n').find((l) => l.includes('0007_index_audit_actor_foreign_keys.sql'));
  assert.ok(line);
  assert.doesNotMatch(line, /each a single transaction/);
  assert.match(line, /0007_index_audit_actor_foreign_keys\.sql`, which has no `begin`\/`commit`/);
  const i11 = doc.indexOf('0011_audit_owner_settle_attribution.sql');
  const i12 = doc.indexOf('0012_settle_entry_rpc.sql');
  const i13 = doc.indexOf('0013_delete_account_cleanup.sql');
  assert.ok(i11 > 0 && i12 > i11 && i13 > i12, 'apply order 0011, 0012, 0013');
});

test('the Supabase repo comment names migration 0010 for delete_member_account', () => {
  const src = fs.readFileSync(path.join(root, 'src/supabase-repo.js'), 'utf8');
  assert.doesNotMatch(src, /delete_member_account \(migration 0005\)/);
  assert.match(src, /delete_member_account \(migration 0010/);
});
