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
const HELP = mapper({ id: 'id', userId: 'user_id', body: 'body', createdAt: 'created_at', resolvedAt: 'resolved_at',
  assignedToId: 'assigned_to', assignedById: 'assigned_by', assignedAt: 'assigned_at' });
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

const USER_PATCH = ['name', 'upiId', 'avatarUrl', 'welcomedAt', 'termsAcceptedAt', 'isAdmin', 'isVerifier', 'emailReminders', 'emailThanks'];
const INVITE_PATCH = ['acceptedAt', 'acceptedUserId', 'revokedAt', 'supersededAt'];
const REQUEST_PATCH = ['status', 'decidedAt', 'fundedAt', 'repaidAt', 'fundedCents', 'rejectionReason', 'repaymentDate',
  'originalRepaymentDate', 'withdrawnAt', 'contactDecidedAt', 'category', 'purpose', 'trustedContactId'];
const ENTRY_PATCH = ['status', 'utr', 'amountCents', 'confirmedAt', 'updatedAt', 'settledBy', 'settledNote', 'settledAt', 'helpRequestedAt'];

// Escape LIKE wildcards so user text is matched literally.
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function createSupabaseRepo({ url, serviceRoleKey, fetch: customFetch }) {
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
    ...(customFetch ? { global: { fetch: customFetch } } : {}),
  });

  // Keeps the PostgREST code (e.g. '23505' unique violation) and details so callers can tell failures apart.
  const fail = (error) => Object.assign(new Error(`Supabase: ${error.message}`), { code: error.code, details: error.details });
  const check = (res) => {
    if (res.error) throw fail(res.error);
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
      // A removed entry is an audit record only: get by id still returns it, lists never do.
      return list(check(await db.from(table).select().eq('request_id', requestId).neq('status', 'removed').order('id', { ascending: true })), m);
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
    if (res.error) throw fail(res.error);
    return res.count ?? 0;
  };

  return {
    // ---- users ----
    findUserByClerkId: (clerkId) => maybe(db.from('users').select().eq('clerk_id', clerkId), USER),
    // Case-insensitive exact match: ilike with LIKE wildcards escaped.
    findUserByEmail: (email) => maybe(db.from('users').select().ilike('email', likeEscape(String(email ?? ''))).limit(1), USER),
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
    // Unified admin listing (both branches): active members, newest first; `query` matches name or email;
    // `limit` caps at 1..200, or null (the default) returns every active member (admin stats, verifier counts).
    async listUsers({ query = '', limit = null } = {}) {
      const cap = limit === null ? null : Math.min(Math.max(limit, 1), 200);
      const base = () => {
        const q = db.from('users').select().is('deleted_at', null).order('id', { ascending: false });
        return cap === null ? q : q.limit(cap);
      };
      if (!query) return list(check(await base()), USER);
      const [byName, byEmail] = await Promise.all([
        base().ilike('name', '%' + likeEscape(query) + '%'),
        base().ilike('email', '%' + likeEscape(query) + '%'),
      ]);
      const combined = new Map([...check(byName), ...check(byEmail)].map((row) => [row.id, row]));
      const merged = [...combined.values()].sort((a,b)=>b.id-a.id);
      return list(cap === null ? merged : merged.slice(0, cap), USER);
    },
    // Count of active (not deleted) members; role 'admin' or 'verifier' narrows it. An exact head count, no row cap.
    async countUsers({ role = null } = {}) {
      let q = db.from('users').select('id', { count: 'exact', head: true }).is('deleted_at', null);
      if (role === 'admin') q = q.eq('is_admin', true);
      else if (role === 'verifier') q = q.eq('is_verifier', true);
      const res = await q;
      if (res.error) throw fail(res.error);
      return res.count ?? 0;
    },
    async setMemberRoles({ actorId, targetUserId, isAdmin, isVerifier }) {
      const row = check(await db.rpc('admin_set_member_roles', {
        p_actor_id: actorId, p_target_user_id: targetUserId, p_is_admin: isAdmin, p_is_verifier: isVerifier,
      }));
      return { id: row.id, name: row.name, email: row.email, isAdmin: row.is_admin, isVerifier: row.is_verifier };
    },
    async listAdminAuditEvents({ limit = 100 } = {}) {
      return check(await db.from('admin_audit_events').select().order('id', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200)))
        .map((r) => ({ id:r.id, actorId:r.actor_id, targetUserId:r.target_user_id, eventType:r.event_type,
          beforeState:r.before_state, afterState:r.after_state, createdAt:r.created_at }));
    },
    async listSupportAuditEvents({ limit = 100 } = {}) {
      return check(await db.from('support_audit_events').select().order('id',{ascending:false}).limit(Math.min(Math.max(limit,1),200)))
        .map((r)=>({id:r.id,actorId:r.actor_id,helpMessageId:r.help_message_id,eventType:r.event_type,
          beforeState:r.before_state,afterState:r.after_state,createdAt:r.created_at}));
    },
    async setVerifier(id, isVerifier) { check(await db.from('users').update({ is_verifier: !!isVerifier }).eq('id', id)); },
    // limit is an integer, or null for the default. Returns the member, or null if the id is unknown.
    setInviteLimit: (id, limit) => maybe(db.from('users').update({ invite_limit: limit }).eq('id', id).select(), USER),
    // entries: [{ id, since }]. Made a request, or has a confirmed contribution, created at or after `since`.
    async membersWhoActed(entries) {
      if (entries.length === 0) return [];
      const since = new Map(entries.map((e) => [e.id, new Date(e.since).getTime()]));
      const ids = [...since.keys()];
      const [asBorrower, asContributor] = await Promise.all([
        db.from('requests').select('borrower_id, created_at').in('borrower_id', ids),
        db.from('contributions').select('contributor_id, created_at').in('contributor_id', ids).eq('status', 'confirmed'),
      ]);
      const after = (id, at) => new Date(at).getTime() >= since.get(id);
      return [...new Set([
        ...check(asBorrower).filter((r) => after(r.borrower_id, r.created_at)).map((r) => r.borrower_id),
        ...check(asContributor).filter((r) => after(r.contributor_id, r.created_at)).map((r) => r.contributor_id),
      ])];
    },
    // Name only (email is private). Parameterised: user text never goes into a filter string.
    async searchUsers(q, excludeId) {
      const pattern = `%${likeEscape(q)}%`;
      const byName = await db.from('users').select().ilike('name', pattern).is('deleted_at', null).neq('id', excludeId).limit(20);
      return list(check(byName), USER).slice(0, 20);
    },

    // Anonymise in place; the row stays so ledger rows keep a valid member. The email column is NOT NULL and unique,
    // so it gets a unique placeholder. Everything happens in one transaction inside delete_member_account (migration 0010,
    // replaced by 0013): the user row, the invite emails, follows, open invites and help-message assignments. Never touches ledger rows. Null if the member does not exist.
    async deleteAccount(id) {
      check(await db.rpc('delete_member_account', { p_user_id: id, p_placeholder_email: `deleted-${id}@deleted.invalid`,
        p_clerk_placeholder: `deleted:${id}` }));
      return maybe(db.from('users').select().eq('id', id), USER);
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
    async findInviteByAcceptedUser(userId) {
      const rows = check(await db.from('invites').select().eq('accepted_user_id', userId).order('id', { ascending: true }).limit(1));
      return rows && rows.length ? INVITE.toObj(rows[0]) : null;
    },
    async findOpenInvitesByEmail(email) {
      // Email comparison is case-insensitive: ilike with wildcards escaped matches the whole address.
      return list(check(await db.from('invites').select().ilike('email', likeEscape(email))
        .is('accepted_at', null).is('revoked_at', null).is('superseded_at', null)), INVITE);
    },
    async listInvites() { return list(check(await db.from('invites').select().order('id', { ascending: false })), INVITE); },
    async listInvitesByInviter(id) {
      return list(check(await db.from('invites').select().eq('inviter_id', id).order('id', { ascending: false })), INVITE);
    },
    async updateInvite(id, patch) {
      const row = INVITE.toRow(patch, INVITE_PATCH);
      if (Object.keys(row).length === 0) return maybe(db.from('invites').select().eq('id', id), INVITE);
      return maybe(db.from('invites').update(row).eq('id', id).select(), INVITE);
    },
    // Single conditional UPDATE: only one caller can flip an open invite. Returns the invite, or null if it was not open.
    async claimInvite(id, { acceptedAt, acceptedUserId } = {}) {
      const patch = INVITE.toRow({ acceptedAt, acceptedUserId });
      return maybe(db.from('invites').update(patch).eq('id', id)
        .is('accepted_at', null).is('revoked_at', null).is('superseded_at', null)
        .gt('expires_at', acceptedAt).select(), INVITE);
    },
    async countInvitesSince(inviterId, isoDate) {
      const res = await db.from('invites').select('id', { count: 'exact', head: true })
        .eq('inviter_id', inviterId).gte('created_at', isoDate).is('revoked_at', null).is('superseded_at', null);
      if (res.error) throw fail(res.error);
      return res.count ?? 0;
    },

    // ---- help messages ----
    async addHelpMessage({ userId, body }) {
      return HELP.toObj(check(await db.from('help_messages').insert({ user_id: userId, body }).select().single()));
    },
    async listHelpMessagesByUser(userId) {
      return list(check(await db.from('help_messages').select().eq('user_id', userId).order('id', { ascending: false })), HELP);
    },
    // Unresolved first (resolved_at null sorts last by default on ascending, so order explicitly), oldest first within each group.
    async listHelpMessages() {
      const rows = list(check(await db.from('help_messages').select().order('id', { ascending: true })), HELP);
      return [...rows.filter((m) => !m.resolvedAt), ...rows.filter((m) => m.resolvedAt)];
    },
    // Assignment and resolution go through audited RPCs (0006): admin-only (42501), unknown id P0002, and a second
    // resolve keeps the first timestamp.
    async assignHelpMessage({ id, actorId, assigneeId }) {
      const row=check(await db.rpc('admin_assign_help_message', {
        p_actor_id:actorId, p_message_id:id, p_assignee_id:assigneeId,
      }));
      return {id:row.id,userId:row.userId,body:row.body,createdAt:row.createdAt,resolvedAt:row.resolvedAt,
        assignedToId:row.assignedTo,assignedById:row.assignedBy,assignedAt:row.assignedAt};
    },
    async resolveHelpMessage(id, at, actorId) {
      const row=check(await db.rpc('admin_resolve_help_message', {
        p_actor_id:actorId, p_message_id:id,
      }));
      return {id:row.id,userId:row.userId,body:row.body,createdAt:row.createdAt,resolvedAt:row.resolvedAt,
        assignedToId:row.assignedTo,assignedById:row.assignedBy,assignedAt:row.assignedAt};
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
    async listRequestsByBorrowers(ids, { statuses } = {}) {
      if (ids.length === 0 || (statuses && statuses.length === 0)) return [];
      let q = db.from('requests').select().in('borrower_id', ids);
      if (statuses) q = q.in('status', statuses);
      return list(check(await q.order('id', { ascending: false }).limit(100)), REQUEST);
    },
    async listRequestsByStatus(status) {
      return list(check(await db.from('requests').select().eq('status', status).order('id', { ascending: false })), REQUEST);
    },
    async listRequestsForMember(userId) {
      const [asBorrower, asContact, asContributor, asPayer, asLender, asVerifier] = await Promise.all([
        db.from('requests').select('id').eq('borrower_id', userId),
        db.from('requests').select('id').eq('nominee_id', userId),
        db.from('contributions').select('request_id').eq('contributor_id', userId).neq('status', 'removed'),
        db.from('repayments').select('request_id').eq('payer_id', userId).neq('status', 'removed'),
        db.from('repayments').select('request_id').eq('lender_id', userId).neq('status', 'removed'),
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
    async listContributionsByStatus(statuses) {
      if (statuses.length === 0) return [];
      return list(check(await db.from('contributions').select().in('status', statuses).order('id', { ascending: true })), CONTRIBUTION);
    },
    async listRepaymentsByStatus(statuses) {
      if (statuses.length === 0) return [];
      return list(check(await db.from('repayments').select().in('status', statuses).order('id', { ascending: true })), REPAYMENT);
    },
    // The entry a committed idempotent create saved (financial_idempotency.response), or null. A row whose response is
    // still null belongs to a create in flight; the record RPC answers that case, so it reads as null here.
    async findIdempotentEntry({ operation, actorId, idempotencyKey }) {
      const row = check(await db.from('financial_idempotency').select('response').eq('operation', operation)
        .eq('actor_id', actorId).eq('idempotency_key', idempotencyKey).maybeSingle());
      if (!row?.response) return null;
      return (operation === 'repayment.create' ? REPAYMENT : CONTRIBUTION).toObj(row.response);
    },
    // Creation uses Postgres RPCs: request-row locks, cap checks, idempotency and audit triggers
    // execute in one database transaction. Never replace these with read/check/insert calls.
    async recordContribution({ requestId, contributorId, amountCents, utr = null, idempotencyKey }) {
      const row = check(await db.rpc('record_contribution', {
        p_request_id: requestId, p_contributor_id: contributorId, p_amount_cents: amountCents,
        p_utr: utr, p_idempotency_key: idempotencyKey,
      }));
      return CONTRIBUTION.toObj(row);
    },
    async recordRepayment({ requestId, payerId, lenderId, amountCents, utr = null, idempotencyKey }) {
      const row = check(await db.rpc('record_repayment', {
        p_request_id: requestId, p_payer_id: payerId, p_lender_id: lenderId,
        p_amount_cents: amountCents, p_utr: utr, p_idempotency_key: idempotencyKey,
      }));
      return REPAYMENT.toObj(row);
    },
    async reviseContribution({ entryId, actorId, amountCents, utr = null }) {
      return CONTRIBUTION.toObj(check(await db.rpc('revise_contribution', {
        p_entry_id: entryId, p_actor_id: actorId, p_amount_cents: amountCents, p_utr: utr,
      })));
    },
    async reviseRepayment({ entryId, actorId, amountCents, utr = null }) {
      return REPAYMENT.toObj(check(await db.rpc('revise_repayment', {
        p_entry_id: entryId, p_actor_id: actorId, p_amount_cents: amountCents, p_utr: utr,
      })));
    },
    // Owner settlement (P-34) through the locked RPCs of migration 0012. Errors keep their code
    // (23514 cap, 42501 self-settle, P0002 missing, 55000 not waiting) so the route can map them.
    async settleContribution({ entryId, actorId, action, note, at }) {
      return CONTRIBUTION.toObj(check(await db.rpc('settle_contribution', {
        p_entry_id: entryId, p_actor_id: actorId, p_action: action, p_note: note, p_at: at,
      })));
    },
    async settleRepayment({ entryId, actorId, action, note, at }) {
      return REPAYMENT.toObj(check(await db.rpc('settle_repayment', {
        p_entry_id: entryId, p_actor_id: actorId, p_action: action, p_note: note, p_at: at,
      })));
    },
    addContribution: contrib.add, getContribution: contrib.get, updateContribution: contrib.update,
    deleteContribution: contrib.del, listContributions: contrib.list,
    addRepayment: repay.add, getRepayment: repay.get, updateRepayment: repay.update,
    deleteRepayment: repay.del, listRepayments: repay.list,
  };
}

module.exports = { createSupabaseRepo };
