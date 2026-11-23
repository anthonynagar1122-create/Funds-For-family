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
        for (const t of ['verifications', 'contributions', 'repayments', 'notes']) await db.from(t).delete().in('request_id', rids);
        await db.from('requests').delete().in('id', rids);
      }
      await db.from('invites').delete().in('inviter_id', ids);
      await db.from('follows').delete().in('follower_id', ids);
      await db.from('follows').delete().in('followee_id', ids);
      await db.from('users').delete().in('id', ids);
    }
  });
}
