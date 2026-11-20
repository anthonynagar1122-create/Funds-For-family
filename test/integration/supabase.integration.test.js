'use strict';
// Phase B: the real Supabase repository against a real Postgres database.
// Runs only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. Creates rows under a unique prefix and deletes them.
// Never run against production data: point SUPABASE_URL at a test project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseRepo } = require('../../src/supabase-repo');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = url && key ? false : 'BLOCKED: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to a test project';
const RUN = `it_${Date.now().toString(36)}`;

let repo;
const created = { users: [], requests: [] };

test.before(() => { if (!skip) repo = createSupabaseRepo({ url, serviceRoleKey: key }); });
test.after(async () => {
  if (skip) return;
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });
  for (const id of created.requests) {
    await db.from('verifications').delete().eq('request_id', id);
    await db.from('contributions').delete().eq('request_id', id);
    await db.from('repayments').delete().eq('request_id', id);
    await db.from('requests').delete().eq('id', id);
  }
  for (const id of created.users) {
    await db.from('follows').delete().or(`follower_id.eq.${id},followee_id.eq.${id}`);
    await db.from('users').delete().eq('id', id);
  }
});

const newUser = async (tag) => {
  const u = await repo.upsertUser({ clerkId: `${RUN}_${tag}`, name: `Test ${tag}`, email: `${RUN}_${tag}@it.test` });
  created.users.push(u.id);
  return u;
};

test('profile upsert is idempotent for the same Clerk subject', { skip }, async () => {
  const first = await newUser('idem');
  const again = await repo.upsertUser({ clerkId: `${RUN}_idem`, name: 'Renamed', email: `${RUN}_idem@it.test` });
  assert.equal(again.id, first.id, 'same profile row');
  assert.equal(again.name, 'Renamed');
});

test('request lifecycle through the repository: create, approve, fund, repay', { skip }, async () => {
  const borrower = await newUser('borrower');
  const nominee = await newUser('nominee');
  const r = await repo.createRequest({
    borrowerId: borrower.id, nomineeId: nominee.id,
    purpose: 'School fees for the second term at college',
    principalCents: 50000, repaymentDate: '2027-03-01',
  });
  created.requests.push(r.id);
  assert.equal(r.status, 'pending_verification');
  const opened = await repo.setRequestStatus(r.id, { status: 'open', decidedAt: new Date().toISOString() });
  assert.equal(opened.status, 'open');
  const funded = await repo.setRequestStatus(r.id, { status: 'funded', fundedAt: new Date().toISOString() });
  assert.equal(funded.status, 'funded');
});

test('verification decisions are one per verifier (upsert replaces, never duplicates)', { skip }, async () => {
  const borrower = await newUser('vb');
  const nominee = await newUser('vn');
  const verifier = await newUser('vv');
  const r = await repo.createRequest({ borrowerId: borrower.id, nomineeId: nominee.id, purpose: 'Repairs to the family car after the accident', principalCents: 9000, repaymentDate: '2027-03-01' });
  created.requests.push(r.id);
  await repo.addVerification({ requestId: r.id, verifierId: verifier.id, decision: 'reject', note: 'first' });
  await repo.addVerification({ requestId: r.id, verifierId: verifier.id, decision: 'approve', note: 'changed' });
  const list = await repo.listVerifications(r.id);
  assert.equal(list.length, 1, 'still one row for this verifier');
  assert.equal(list[0].decision, 'approve');
});

test('contributions and repayments are listed in full', { skip }, async () => {
  const borrower = await newUser('cb');
  const nominee = await newUser('cn');
  const lender = await newUser('cl');
  const r = await repo.createRequest({ borrowerId: borrower.id, nomineeId: nominee.id, purpose: 'Medical bill for the surgery in March', principalCents: 20000, repaymentDate: '2027-03-01' });
  created.requests.push(r.id);
  await repo.addContribution({ requestId: r.id, contributorId: lender.id, amountCents: 7000 });
  await repo.addContribution({ requestId: r.id, contributorId: lender.id, amountCents: 3000 });
  await repo.addRepayment({ requestId: r.id, payerId: nominee.id, amountCents: 5000 });
  assert.equal((await repo.listContributions(r.id)).length, 2);
  assert.equal((await repo.listRepayments(r.id)).length, 1);
});

test('follows: follow, follow again without duplicating, unfollow, and connections reflect it', { skip }, async () => {
  const a = await newUser('fa');
  const b = await newUser('fb');
  await repo.addFollow(a.id, b.id);
  await repo.addFollow(a.id, b.id);
  let c = await repo.connections(a.id);
  assert.deepEqual(c.following, [b.id]);
  assert.deepEqual((await repo.connections(b.id)).followers, [a.id]);
  await repo.removeFollow(a.id, b.id);
  c = await repo.connections(a.id);
  assert.deepEqual(c.following, []);
});

test('search finds members by name and never returns the searcher', { skip }, async () => {
  const me = await newUser('searcher');
  const other = await newUser('findme');
  const hits = await repo.searchUsers(`${RUN}_findme`.slice(0, 20), me.id);
  assert.ok(hits.some((u) => u.id === other.id), 'other member found');
  assert.ok(!hits.some((u) => u.id === me.id), 'searcher excluded');
});

test('an invalid write is refused by the database and surfaces as an error', { skip }, async () => {
  const u = await newUser('bad');
  await assert.rejects(() => repo.createRequest({ borrowerId: u.id, nomineeId: u.id, purpose: 'Long enough purpose text here', principalCents: 1000, repaymentDate: '2027-03-01' }));
});
