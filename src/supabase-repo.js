'use strict';
// Production repository backed by Supabase Postgres. Same contract as src/memory-repo.js.
// Uses the SERVICE ROLE key, so it must only run on the server (Vercel functions / local node).
const { createClient } = require('@supabase/supabase-js');

const ACTIVE = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open', 'funded'];

// One mapper per entity: snake_case row <-> camelCase object. Columns are listed explicitly so a patch can never
// write a column the contract does not allow.
const mapper = (cols) => {
  const toObj = (row) => {
    if (!row) return null;
    const out = {};
    for (const [camelKey, snake] of Object.entries(cols)) out[camelKey] = row[snake] ?? null;
    return out;
  };
  const toRow = (obj, allowed = Object.keys(cols)) => {
    const row = {};
    for (const k of allowed) if (obj && obj[k] !== undefined) row[cols[k]] = obj[k];
    return row;
  };
  return { toObj, toRow };
};

const USER = mapper({
  id: 'id', clerkId: 'clerk_id', name: 'name', email: 'email', avatarUrl: 'avatar_url', upiId: 'upi_id',
  isAdmin: 'is_admin', isVerifier: 'is_verifier', inviteLimit: 'invite_limit', emailReminders: 'email_reminders',
  emailThanks: 'email_thanks', welcomedAt: 'welcomed_at', termsAcceptedAt: 'terms_accepted_at', deletedAt: 'deleted_at', createdAt: 'created_at',
});
const INVITE = mapper({
  id: 'id', inviterId: 'inviter_id', email: 'email', tokenHash: 'token_hash', expiresAt: 'expires_at', createdAt: 'created_at',
  acceptedAt: 'accepted_at', acceptedUserId: 'accepted_user_id', revokedAt: 'revoked_at', supersededAt: 'superseded_at',
});
const REQUEST = mapper({
  id: 'id', borrowerId: 'borrower_id', trustedContactId: 'nominee_id', purpose: 'purpose', category: 'category',
  principalCents: 'principal_cents', repaymentDate: 'repayment_date', originalRepaymentDate: 'original_repayment_date',
  status: 'status', fundedCents: 'funded_cents', rejectionReason: 'rejection_reason', createdAt: 'created_at',
  decidedAt: 'decided_at', fundedAt: 'funded_at', repaidAt: 'repaid_at', withdrawnAt: 'withdrawn_at', contactDecidedAt: 'contact_decided_at',
});
const ENTRY_COMMON = {
  id: 'id', requestId: 'request_id', amountCents: 'amount_cents', status: 'status', utr: 'utr', createdAt: 'created_at',
  confirmedAt: 'confirmed_at', updatedAt: 'updated_at', settledBy: 'settled_by', settledNote: 'settled_note',
  settledAt: 'settled_at', helpRequestedAt: 'help_requested_at',
};
const CONTRIBUTION = mapper({ ...ENTRY_COMMON, contributorId: 'contributor_id' });
const REPAYMENT = mapper({ ...ENTRY_COMMON, payerId: 'payer_id', lenderId: 'lender_id' });
const VERIFICATION = mapper({ requestId: 'request_id', verifierId: 'verifier_id', decision: 'decision', note: 'note', createdAt: 'created_at' });

const USER_PATCH = ['name', 'upiId', 'avatarUrl', 'welcomedAt', 'termsAcceptedAt'];
const INVITE_PATCH = ['acceptedAt', 'acceptedUserId', 'revokedAt', 'supersededAt'];
const REQUEST_PATCH = ['status', 'decidedAt', 'fundedAt', 'repaidAt', 'fundedCents', 'rejectionReason', 'repaymentDate',
  'originalRepaymentDate', 'withdrawnAt', 'contactDecidedAt', 'category', 'purpose'];
const ENTRY_PATCH = ['status', 'utr', 'amountCents', 'confirmedAt', 'updatedAt', 'settledBy', 'settledNote', 'settledAt', 'helpRequestedAt'];

// Escape LIKE wildcards so user text is matched literally.
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function createSupabaseRepo({ url, serviceRoleKey }) {
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  const check = (res) => {
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.data;
  };
  const maybe = async (query, m) => m.toObj(check(await query.maybeSingle()));
  const list = (rows, m) => (rows ?? []).map(m.toObj);

  const entryApi = (table, m, create) => ({
    async add(row) {
      return m.toObj(check(await db.from(table).insert(create(row)).select().single()));
    },
    get: (id) => maybe(db.from(table).select().eq('id', id), m),
    async update(id, patch) {
      const row = m.toRow(patch, ENTRY_PATCH);
      if (Object.keys(row).length === 0) return maybe(db.from(table).select().eq('id', id), m);
      return maybe(db.from(table).update(row).eq('id', id).select(), m);
    },
    async del(id) { check(await db.from(table).delete().eq('id', id)); },
    async list(requestId) {
      return list(check(await db.from(table).select().eq('request_id', requestId).order('id', { ascending: true })), m);
    },
  });
  const entryRow = (m, row) => {
    const r = m.toRow({ ...row, status: row.status ?? 'sent' });
    if (r.created_at === undefined) delete r.created_at;
    delete r.id;
    return r;
  };
  const contrib = entryApi('contributions', CONTRIBUTION, (row) => entryRow(CONTRIBUTION, row));
  const repay = entryApi('repayments', REPAYMENT, (row) => entryRow(REPAYMENT, row));

  const countRequests = async (column, id) => {
    const res = await db.from('requests').select('id', { count: 'exact', head: true }).eq(column, id).in('status', ACTIVE);
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.count ?? 0;
  };

  return {
    // ---- users ----
    findUserByClerkId: (clerkId) => maybe(db.from('users').select().eq('clerk_id', clerkId), USER),
    async createUser({ clerkId, name, email, avatarUrl, isAdmin, isVerifier }) {
      const row = USER.toRow({ clerkId, name: name || 'Member', email, avatarUrl, isAdmin, isVerifier });
      return USER.toObj(check(await db.from('users').insert(row).select().single()));
    },
    async updateUser(id, patch) {
      const row = USER.toRow(patch, USER_PATCH);
      if (Object.keys(row).length === 0) return maybe(db.from('users').select().eq('id', id), USER);
      return maybe(db.from('users').update(row).eq('id', id).select(), USER);
    },
    getUser: (id) => maybe(db.from('users').select().eq('id', id), USER),
    async getUsers(ids) {
      if (ids.length === 0) return [];
      return list(check(await db.from('users').select().in('id', ids)), USER);
    },
    async setVerifier(id, isVerifier) { check(await db.from('users').update({ is_verifier: !!isVerifier }).eq('id', id)); },
    // Two parameterised queries merged in code: user text never goes into a filter string.
    async searchUsers(q, excludeId) {
      const pattern = `%${likeEscape(q)}%`;
      const [byName, byEmail] = await Promise.all([
        db.from('users').select().ilike('name', pattern).neq('id', excludeId).limit(20),
        db.from('users').select().ilike('email', pattern).neq('id', excludeId).limit(20),
      ]);
      const seen = new Map();
      for (const u of [...list(check(byName), USER), ...list(check(byEmail), USER)]) if (!seen.has(u.id)) seen.set(u.id, u);
      return [...seen.values()].slice(0, 20);
    },

    // ---- follows ----
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
      return { following: check(a).map((r) => r.followee_id), followers: check(b).map((r) => r.follower_id) };
    },

    // ---- invites ----
    async createInvite({ inviterId, email, tokenHash, expiresAt, createdAt }) {
      const row = INVITE.toRow({ inviterId, email, tokenHash, expiresAt, createdAt });
      return INVITE.toObj(check(await db.from('invites').insert(row).select().single()));
    },
    getInvite: (id) => maybe(db.from('invites').select().eq('id', id), INVITE),
    findInviteByHash: (hash) => maybe(db.from('invites').select().eq('token_hash', hash), INVITE),
    async findOpenInvitesByEmail(email) {
      // Email comparison is case-insensitive: ilike with wildcards escaped matches the whole address.
      return list(check(await db.from('invites').select().ilike('email', likeEscape(email))
        .is('accepted_at', null).is('revoked_at', null).is('superseded_at', null)), INVITE);
    },
    async listInvitesByInviter(id) {
      return list(check(await db.from('invites').select().eq('inviter_id', id).order('id', { ascending: false })), INVITE);
    },
    async updateInvite(id, patch) {
      const row = INVITE.toRow(patch, INVITE_PATCH);
      if (Object.keys(row).length === 0) return maybe(db.from('invites').select().eq('id', id), INVITE);
      return maybe(db.from('invites').update(row).eq('id', id).select(), INVITE);
    },
    async countInvitesSince(inviterId, isoDate) {
      const res = await db.from('invites').select('id', { count: 'exact', head: true })
        .eq('inviter_id', inviterId).gte('created_at', isoDate).is('revoked_at', null).is('superseded_at', null);
      if (res.error) throw new Error(`Supabase: ${res.error.message}`);
      return res.count ?? 0;
    },

    // ---- requests ----
    async createRequest(row) {
      const insert = REQUEST.toRow(row, ['borrowerId', 'trustedContactId', 'purpose', 'category', 'principalCents', 'repaymentDate',
        'originalRepaymentDate', 'status', 'createdAt']);
      return REQUEST.toObj(check(await db.from('requests').insert(insert).select().single()));
    },
    getRequest: (id) => maybe(db.from('requests').select().eq('id', id), REQUEST),
    async updateRequest(id, patch) {
      const row = REQUEST.toRow(patch, REQUEST_PATCH);
      if (Object.keys(row).length === 0) return maybe(db.from('requests').select().eq('id', id), REQUEST);
      return maybe(db.from('requests').update(row).eq('id', id).select(), REQUEST);
    },
    async listRequestsByBorrowers(ids) {
      if (ids.length === 0) return [];
      return list(check(await db.from('requests').select().in('borrower_id', ids).order('id', { ascending: false }).limit(100)), REQUEST);
    },
    async listRequestsForMember(userId) {
      const [asBorrower, asContact, asContributor, asPayer, asLender, asVerifier] = await Promise.all([
        db.from('requests').select('id').eq('borrower_id', userId),
        db.from('requests').select('id').eq('nominee_id', userId),
        db.from('contributions').select('request_id').eq('contributor_id', userId),
        db.from('repayments').select('request_id').eq('payer_id', userId),
        db.from('repayments').select('request_id').eq('lender_id', userId),
        db.from('verifications').select('request_id').eq('verifier_id', userId),
      ]);
      const ids = new Set([
        ...check(asBorrower).map((r) => r.id),
        ...check(asContact).map((r) => r.id),
        ...check(asContributor).map((r) => r.request_id),
        ...check(asPayer).map((r) => r.request_id),
        ...check(asLender).map((r) => r.request_id),
        ...check(asVerifier).map((r) => r.request_id),
      ]);
      if (ids.size === 0) return [];
      return list(check(await db.from('requests').select().in('id', [...ids]).order('id', { ascending: false })), REQUEST);
    },
    countActiveByBorrower: (id) => countRequests('borrower_id', id),
    countActiveAsContact: (id) => countRequests('nominee_id', id),

    // ---- verifications ----
    async listVerifications(requestId) {
      return list(check(await db.from('verifications').select().eq('request_id', requestId)), VERIFICATION);
    },
    async addVerification({ requestId, verifierId, decision, note, createdAt }) {
      const row = VERIFICATION.toRow({ requestId, verifierId, decision, note: note ?? '', createdAt });
      check(await db.from('verifications').upsert(row, { onConflict: 'request_id,verifier_id' }));
    },

    // ---- contributions and repayments ----
    addContribution: contrib.add, getContribution: contrib.get, updateContribution: contrib.update,
    deleteContribution: contrib.del, listContributions: contrib.list,
    addRepayment: repay.add, getRepayment: repay.get, updateRepayment: repay.update,
    deleteRepayment: repay.del, listRepayments: repay.list,
  };
}

module.exports = { createSupabaseRepo };
