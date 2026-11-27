'use strict';
// The real Supabase repository against a real Postgres database (staging only).
// Runs only when SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) are set.
// Refuses to run against production. Creates rows under a unique prefix and deletes them afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseRepo } = require('../../src/supabase-repo');
const { runContract } = require('../repo-contract.test');

const PRODUCTION_REF = 'enqxchwiqfdqwrvuqlph';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let skip = false;
if ((url || '').toLowerCase().includes(PRODUCTION_REF)) skip = 'REFUSED: SUPABASE_URL points at production; use the staging project';
else if (!url || !key) skip = 'BLOCKED: set SUPABASE_URL and SUPABASE_SECRET_KEY to the staging project';

const RUN = `it_${Date.now().toString(36)}_`;

if (skip) {
  test('supabase repository contract', { skip }, () => {});
} else {
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });

  runContract(async () => createSupabaseRepo({ url, serviceRoleKey: key }), { prefix: RUN });

  test('atomic financial RPCs cap, replay safely, and audit their writes', async () => {
    const repo = createSupabaseRepo({ url, serviceRoleKey: key });
    const borrower = await repo.createUser({ clerkId: `${RUN}atomic_b`, name: 'Atomic Borrower', email: `${RUN}atomic_b@it.test` });
    const contact = await repo.createUser({ clerkId: `${RUN}atomic_c`, name: 'Atomic Contact', email: `${RUN}atomic_c@it.test` });
    const lender = await repo.createUser({ clerkId: `${RUN}atomic_l`, name: 'Atomic Lender', email: `${RUN}atomic_l@it.test` });
    await repo.addFollow(lender.id, borrower.id);
    await repo.addFollow(borrower.id, lender.id);
    const request = await repo.createRequest({ borrowerId: borrower.id, trustedContactId: contact.id,
      purpose: 'Atomic financial integration test purpose', principalCents: 50000,
      repaymentDate: '2027-03-01', status: 'open' });
    const key1 = `${RUN}contribution_001`;
    const first = await repo.recordContribution({ requestId: request.id, contributorId: lender.id,
      amountCents: 30000, utr: null, idempotencyKey: key1 });
    const replay = await repo.recordContribution({ requestId: request.id, contributorId: lender.id,
      amountCents: 30000, utr: null, idempotencyKey: key1 });
    assert.equal(replay.id, first.id, 'same key and payload returns the original entry');
    await assert.rejects(() => repo.recordContribution({ requestId: request.id, contributorId: lender.id,
      amountCents: 20000, utr: null, idempotencyKey: key1 }), /different contribution/i);
    await assert.rejects(() => repo.recordContribution({ requestId: request.id, contributorId: lender.id,
      amountCents: 20001, utr: null, idempotencyKey: `${RUN}contribution_002` }), /paise is still needed/i);
    await repo.updateContribution(first.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
    await repo.updateRequest(request.id, { status: 'funded' });
    const repayment = await repo.recordRepayment({ requestId: request.id, payerId: borrower.id, lenderId: lender.id,
      amountCents: 10000, utr: null, idempotencyKey: `${RUN}repayment_001` });
    const repaymentReplay = await repo.recordRepayment({ requestId: request.id, payerId: borrower.id, lenderId: lender.id,
      amountCents: 10000, utr: null, idempotencyKey: `${RUN}repayment_001` });
    assert.equal(repaymentReplay.id, repayment.id);
    const { count } = await db.from('financial_audit_events').select('id', { count: 'exact', head: true }).eq('request_id', request.id);
    assert.ok(count >= 3, 'insert and state transitions are audited');
  });

  test('an invalid write is refused by the database and surfaces as an error', async () => {
    const repo = createSupabaseRepo({ url, serviceRoleKey: key });
    const u = await repo.createUser({ clerkId: `${RUN}bad`, name: 'Bad', email: `${RUN}bad@it.test` });
    await assert.rejects(() => repo.createRequest({
      borrowerId: u.id, trustedContactId: u.id, purpose: 'Long enough purpose text here', principalCents: 20000, repaymentDate: '2027-03-01',
    }));
  });

  test.after(async () => {
    const { data: users } = await db.from('users').select('id').like('clerk_id', `${RUN}%`);
    const ids = (users ?? []).map((u) => u.id);
    if (ids.length) {
      const list = ids.join(',');
      const { data: reqs } = await db.from('requests').select('id').or(`borrower_id.in.(${list}),nominee_id.in.(${list})`);
      const rids = (reqs ?? []).map((r) => r.id);
      if (rids.length) {
        await db.from('financial_audit_events').delete().in('request_id', rids);
        for (const t of ['verifications', 'contributions', 'repayments', 'notes']) await db.from(t).delete().in('request_id', rids);
        await db.from('requests').delete().in('id', rids);
      }
      await db.from('financial_idempotency').delete().in('actor_id', ids);
      await db.from('invites').delete().in('inviter_id', ids);
      await db.from('follows').delete().in('follower_id', ids);
      await db.from('follows').delete().in('followee_id', ids);
      await db.from('users').delete().in('id', ids);
    }
  });
}
