'use strict';
// Production repository backed by Supabase Postgres. Same contract as src/memory-repo.js.
// Uses the SERVICE ROLE key, so it must only run on the server (Vercel functions / local node).
const { createClient } = require('@supabase/supabase-js');

const camel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const many = (rows) => (rows ?? []).map(camel);

function createSupabaseRepo({ url, serviceRoleKey }) {
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  const check = (res) => {
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.data;
  };

  return {
    async upsertUser({ clerkId, name, email }) {
      const data = check(await db.from('users')
        .upsert({ clerk_id: clerkId, name: name || 'Member', email }, { onConflict: 'clerk_id' })
        .select().single());
      return camel(data);
    },
    async getUser(id) {
      const { data, error } = await db.from('users').select().eq('id', id).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return camel(data);
    },
    async findUserByEmail(email) {
      const { data, error } = await db.from('users').select().ilike('email', email).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return camel(data);
    },
    async setPhone(id, phone) {
      return camel(check(await db.from('users').update({ phone }).eq('id', id).select().single()));
    },
    async setVerifier(id, isVerifier) {
      check(await db.from('users').update({ is_verifier: isVerifier }).eq('id', id));
    },
    async searchUsers(q, excludeId) {
      const term = q.replace(/[%_,()]/g, '');
      return many(check(await db.from('users').select()
        .ilike('name', `%${term}%`)
        .neq('id', excludeId).limit(20)));
    },
    async addFollow(followerId, followeeId) {
      check(await db.from('follows').upsert({ follower_id: followerId, followee_id: followeeId }, { onConflict: 'follower_id,followee_id', ignoreDuplicates: true }));
    },
    async removeFollow(followerId, followeeId) {
      check(await db.from('follows').delete().eq('follower_id', followerId).eq('followee_id', followeeId));
    },
    async connections(userId) {
      const [a, b] = await Promise.all([
        db.from('follows').select('followee_id').eq('follower_id', userId),
        db.from('follows').select('follower_id').eq('followee_id', userId),
      ]);
      return {
        following: check(a).map((r) => r.followee_id),
        followers: check(b).map((r) => r.follower_id),
      };
    },
    async addInvite({ inviterId, email = null, token }) {
      check(await db.from('invites').insert({ inviter_id: inviterId, email, token }));
    },
    async getInviteByToken(token) {
      const { data, error } = await db.from('invites').select().eq('token', token).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return camel(data);
    },
    async markInviteAccepted(token, at) {
      check(await db.from('invites').update({ accepted_at: at }).eq('token', token).is('accepted_at', null));
    },
    // Every follow where either side is one of the given members.
    async followsTouching(userIds) {
      if (userIds.length === 0) return [];
      const [a, b] = await Promise.all([
        // Only follows made BY these members are used (see rules.suggestConnections). Capped for large circles.
        db.from('follows').select('follower_id, followee_id').in('follower_id', userIds).limit(5000),
        Promise.resolve({ data: [], error: null }),
      ]);
      const seen = new Set();
      return [...check(a), ...check(b)].filter((r) => {
        const k = `${r.follower_id}>${r.followee_id}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).map((r) => ({ followerId: r.follower_id, followeeId: r.followee_id }));
    },
    async createRequest(row) {
      const data = check(await db.from('requests').insert({
        borrower_id: row.borrowerId, nominee_id: row.nomineeId, purpose: row.purpose,
        principal_cents: row.principalCents, repayment_date: row.repaymentDate,
      }).select().single());
      return camel(data);
    },
    async getRequest(id) {
      const { data, error } = await db.from('requests').select().eq('id', id).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return camel(data);
    },
    async setRequestStatus(id, patch) {
      const map = { status: 'status', decidedAt: 'decided_at', fundedAt: 'funded_at', repaidAt: 'repaid_at' };
      const row = {};
      for (const [k, v] of Object.entries(patch)) row[map[k]] = v;
      return camel(check(await db.from('requests').update(row).eq('id', id).select().single()));
    },
    async listFeed(borrowerIds) {
      if (borrowerIds.length === 0) return [];
      return many(check(await db.from('requests').select().in('borrower_id', borrowerIds).order('id', { ascending: false }).limit(100)));
    },
    // Requests still awaiting a verification decision, oldest first.
    // excludeDecidedBy: skip requests this verifier already decided on (done in the query, so the limit never hides newer ones).
    async listPendingRequests({ excludeDecidedBy } = {}) {
      let q = db.from('requests').select().eq('status', 'pending_verification');
      if (excludeDecidedBy != null) {
        const decided = check(await db.from('verifications').select('request_id').eq('verifier_id', excludeDecidedBy)).map((v) => v.request_id);
        if (decided.length > 0) q = q.not('id', 'in', `(${decided.map(Number).join(',')})`);
      }
      return many(check(await q.order('id', { ascending: true }).limit(200)));
    },
    async listRequestsForMember(userId) {
      const [asParty, asLender, asPayer, asVerifier] = await Promise.all([
        db.from('requests').select('id').or(`borrower_id.eq.${userId},nominee_id.eq.${userId}`),
        db.from('contributions').select('request_id').eq('contributor_id', userId),
        db.from('repayments').select('request_id').eq('payer_id', userId),
        db.from('verifications').select('request_id').eq('verifier_id', userId),
      ]);
      const ids = new Set([
        ...check(asParty).map((r) => r.id),
        ...check(asLender).map((r) => r.request_id),
        ...check(asPayer).map((r) => r.request_id),
        ...check(asVerifier).map((r) => r.request_id),
      ]);
      if (ids.size === 0) return [];
      return many(check(await db.from('requests').select().in('id', [...ids]).order('id', { ascending: false })));
    },
    async listVerifications(requestId) {
      return many(check(await db.from('verifications').select().eq('request_id', requestId)))
        .map((v) => ({ ...v }));
    },
    async addVerification({ requestId, verifierId, decision, note }) {
      check(await db.from('verifications').upsert({ request_id: requestId, verifier_id: verifierId, decision, note },
        { onConflict: 'request_id,verifier_id' }));
    },
    async listContributions(requestId) {
      return many(check(await db.from('contributions').select().eq('request_id', requestId)));
    },
    async addContribution({ requestId, contributorId, amountCents }) {
      check(await db.from('contributions').insert({ request_id: requestId, contributor_id: contributorId, amount_cents: amountCents }));
    },
    // Locked, idempotent write (see supabase/migrations/0004_atomic_contributions.sql).
    // Resolves to { ok, reason?, remainingCents?, duplicate?, contributionId?, funded? }.
    async addContributionAtomic({ requestId, contributorId, amountCents, idempotencyKey = null }) {
      const { data, error } = await db.rpc('add_contribution', {
        p_request_id: requestId, p_contributor_id: contributorId, p_amount_cents: amountCents, p_idempotency_key: idempotencyKey,
      });
      if (error) throw new Error(`Supabase: ${error.message}`);
      return {
        ok: data.ok,
        reason: data.reason,
        remainingCents: data.remaining_cents,
        duplicate: data.duplicate,
        contributionId: data.contribution_id,
        funded: data.funded,
      };
    },
    // Remove personal data but keep the rows that the money trail depends on (requests, contributions, repayments).
    async anonymizeUser(id) {
      const tomb = `deleted-${id}`;
      check(await db.from('users').update({
        clerk_id: tomb, name: 'Deleted member', email: `${tomb}@deleted.invalid`, phone: null, is_verifier: false,
      }).eq('id', id));
      check(await db.from('follows').delete().or(`follower_id.eq.${id},followee_id.eq.${id}`));
      check(await db.from('invites').delete().eq('inviter_id', id));
    },
    async listRepayments(requestId) {
      return many(check(await db.from('repayments').select().eq('request_id', requestId)));
    },
    async recordEvent({ actorId, action, subjectType = null, subjectId = null, detail = null, ip = null }) {
      check(await db.from('audit_events').insert({
        actor_id: actorId, action, subject_type: subjectType,
        subject_id: subjectId == null ? null : String(subjectId), detail, ip,
      }));
    },
    async addRepayment({ requestId, payerId, amountCents }) {
      check(await db.from('repayments').insert({ request_id: requestId, payer_id: payerId, amount_cents: amountCents }));
    },
  };
}

module.exports = { createSupabaseRepo };
