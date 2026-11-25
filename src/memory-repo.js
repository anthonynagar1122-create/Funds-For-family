'use strict';
// In-memory repository. Same contract as src/supabase-repo.js. Used by tests and local demos.
// Every method is async and returns plain camelCase objects (copies, so callers cannot mutate stored rows).
let seq = 0;
const nextId = () => ++seq;

const ACTIVE = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open', 'funded'];
const copy = (o) => (o ? { ...o } : null);
const patchOnly = (patch, allowed) => {
  const out = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch ?? {}, k)) out[k] = patch[k];
  return out;
};

const USER_PATCH = ['name', 'upiId', 'avatarUrl', 'welcomedAt', 'termsAcceptedAt', 'isAdmin', 'isVerifier', 'emailReminders', 'emailThanks'];
const INVITE_PATCH = ['acceptedAt', 'acceptedUserId', 'revokedAt', 'supersededAt'];
const REQUEST_PATCH = ['status', 'decidedAt', 'fundedAt', 'repaidAt', 'fundedCents', 'rejectionReason', 'repaymentDate',
  'originalRepaymentDate', 'withdrawnAt', 'contactDecidedAt', 'category', 'purpose', 'trustedContactId'];
const ENTRY_PATCH = ['status', 'utr', 'amountCents', 'confirmedAt', 'updatedAt', 'settledBy', 'settledNote', 'settledAt', 'helpRequestedAt'];

function createMemoryRepo() {
  const users = new Map();          // id -> user
  const follows = [];               // {followerId, followeeId}
  const invites = new Map();
  const requests = new Map();
  const verifications = [];         // {requestId, verifierId, decision, note, createdAt}
  const contributions = new Map();
  const repayments = new Map();
  const helpMessages = new Map();
  const financialIdempotency = new Map();
  const adminAuditEvents = [];
  const supportAuditEvents = [];

  const entryApi = (store, add, get, update, del, list) => ({
    async [add](row) {
      const r = { id: nextId(), status: 'sent', utr: null, confirmedAt: null, updatedAt: null, settledBy: null, settledNote: null, settledAt: null, helpRequestedAt: null, createdAt: new Date().toISOString(), ...row };
      store.set(r.id, r);
      return copy(r);
    },
    async [get](id) { return copy(store.get(id)); },
    async [update](id, patch) {
      const r = store.get(id);
      if (!r) return null;
      Object.assign(r, patchOnly(patch, ENTRY_PATCH));
      return copy(r);
    },
    async [del](id) { store.delete(id); },
    async [list](requestId) { return [...store.values()].filter((e) => e.requestId === requestId).map(copy); },
  });

  return {
    // ---- users ----
    async findUserByClerkId(clerkId) { return copy([...users.values()].find((u) => u.clerkId === clerkId)); },
    async findUserByEmail(email) {
      const e = String(email ?? '').toLowerCase();
      return copy([...users.values()].find((u) => String(u.email ?? '').toLowerCase() === e));
    },
    async createUser({ clerkId, name, email, avatarUrl = null, isAdmin = false, isVerifier = false }) {
      const id = nextId();
      const u = { id, clerkId, name, email, avatarUrl, upiId: null, isAdmin, isVerifier, inviteLimit: null,
        emailReminders: true, emailThanks: true, welcomedAt: null, termsAcceptedAt: null, deletedAt: null, createdAt: new Date().toISOString() };
      users.set(id, u);
      return copy(u);
    },
    async updateUser(id, patch) {
      const u = users.get(id);
      if (!u) return null;
      Object.assign(u, patchOnly(patch, USER_PATCH));
      return copy(u);
    },
    async getUser(id) { return copy(users.get(id)); },
    async getUsers(ids) { return ids.map((id) => users.get(id)).filter(Boolean).map(copy); },
    async listUsers({ query = '', limit = 100 } = {}) {
      const q = String(query).trim().toLowerCase();
      return [...users.values()].filter((u) => !u.deletedAt && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)))
        .sort((a,b)=>b.id-a.id).slice(0, Math.min(Math.max(limit,1),200)).map(copy);
    },
    async setMemberRoles({ actorId, targetUserId, isAdmin, isVerifier }) {
      const actor = users.get(actorId), target = users.get(targetUserId);
      if (!actor?.isAdmin || actor.deletedAt) throw Object.assign(new Error('Admins only'), { code:'42501' });
      if (!target || target.deletedAt) throw Object.assign(new Error('Member not found'), { code:'P0002' });
      const beforeState = { isAdmin: !!target.isAdmin, isVerifier: !!target.isVerifier };
      const admins = [...users.values()].filter((u)=>u.isAdmin && !u.deletedAt).length;
      if (target.isAdmin && !isAdmin && admins <= 1) throw Object.assign(new Error('The last administrator cannot be removed'), { code:'23514' });
      target.isAdmin = !!isAdmin; target.isVerifier = !!isVerifier;
      adminAuditEvents.push({ id: adminAuditEvents.length+1, actorId, targetUserId, eventType:'member.roles_updated',
        beforeState, afterState:{ isAdmin:target.isAdmin, isVerifier:target.isVerifier }, createdAt:new Date().toISOString() });
      return { id:target.id, name:target.name, email:target.email, isAdmin:target.isAdmin, isVerifier:target.isVerifier };
    },
    async listAdminAuditEvents({ limit = 100 } = {}) { return adminAuditEvents.slice().reverse().slice(0, Math.min(Math.max(limit,1),200)).map(copy); },
    async setVerifier(id, isVerifier) { users.get(id).isVerifier = !!isVerifier; },
    async searchUsers(q, excludeId) {
      const s = q.toLowerCase();
      return [...users.values()].filter((u) => u.id !== excludeId && !u.deletedAt && u.name.toLowerCase().includes(s)).slice(0, 20).map(copy);
    },

    // Anonymise in place; the row stays so ledger rows keep a valid member. Follows and open invites go. Never touches ledger rows.
    async deleteAccount(id) {
      const u = users.get(id);
      if (!u) return null;
      Object.assign(u, { name: 'Former member', email: `deleted-${id}@deleted.invalid`, upiId: null, avatarUrl: null,
        clerkId: `deleted:${id}`, deletedAt: new Date().toISOString() });
      for (let i = follows.length - 1; i >= 0; i--) if (follows[i].followerId === id || follows[i].followeeId === id) follows.splice(i, 1);
      for (const inv of invites.values()) if (inv.acceptedUserId === id) inv.email = `deleted-${id}@deleted.invalid`;
      for (const [iid, inv] of invites) {
        if ((inv.inviterId === id || inv.acceptedUserId === id) && !inv.acceptedAt && !inv.revokedAt && !inv.supersededAt) invites.delete(iid);
      }
      return copy(u);
    },

    // ---- follows ----
    async addFollow(followerId, followeeId) {
      if (!follows.some((f) => f.followerId === followerId && f.followeeId === followeeId)) follows.push({ followerId, followeeId });
    },
    async removeFollow(followerId, followeeId) {
      const i = follows.findIndex((f) => f.followerId === followerId && f.followeeId === followeeId);
      if (i >= 0) follows.splice(i, 1);
    },
    async connections(userId) {
      const following = follows.filter((f) => f.followerId === userId).map((f) => f.followeeId);
      const followers = follows.filter((f) => f.followeeId === userId).map((f) => f.followerId);
      return { following, followers };
    },

    // ---- invites ----
    async createInvite({ inviterId, email, tokenHash, expiresAt, createdAt }) {
      const i = { id: nextId(), inviterId, email, tokenHash, expiresAt, createdAt: createdAt ?? new Date().toISOString(),
        acceptedAt: null, acceptedUserId: null, revokedAt: null, supersededAt: null };
      invites.set(i.id, i);
      return copy(i);
    },
    async getInvite(id) { return copy(invites.get(id)); },
    async findInviteByHash(hash) { return copy([...invites.values()].find((i) => i.tokenHash === hash)); },
    async findInviteByAcceptedUser(userId) {
      return copy([...invites.values()].filter((i) => i.acceptedUserId === userId).sort((a, b) => a.id - b.id)[0]);
    },
    async findOpenInvitesByEmail(email) {
      const e = email.toLowerCase();
      return [...invites.values()].filter((i) => i.email.toLowerCase() === e && !i.acceptedAt && !i.revokedAt && !i.supersededAt).map(copy);
    },
    async listInvitesByInviter(id) { return [...invites.values()].filter((i) => i.inviterId === id).sort((a, b) => b.id - a.id).map(copy); },
    async updateInvite(id, patch) {
      const i = invites.get(id);
      if (!i) return null;
      Object.assign(i, patchOnly(patch, INVITE_PATCH));
      return copy(i);
    },
    // Atomic in effect: one synchronous check-and-set. Returns the claimed invite, or null if it was not open.
    async claimInvite(id, { acceptedAt, acceptedUserId } = {}) {
      const i = invites.get(id);
      if (!i || i.acceptedAt || i.revokedAt || i.supersededAt) return null;
      if (!(new Date(i.expiresAt).getTime() > new Date(acceptedAt).getTime())) return null;
      i.acceptedAt = acceptedAt;
      if (acceptedUserId !== undefined) i.acceptedUserId = acceptedUserId;
      return copy(i);
    },
    async countInvitesSince(inviterId, isoDate) {
      const from = new Date(isoDate).getTime();
      return [...invites.values()].filter((i) => i.inviterId === inviterId && !i.revokedAt && !i.supersededAt && new Date(i.createdAt).getTime() >= from).length;
    },

    // ---- requests ----
    async createRequest(row) {
      const r = { id: nextId(), status: 'pending_verification', category: null, fundedCents: null, rejectionReason: null,
        originalRepaymentDate: null, withdrawnAt: null, contactDecidedAt: null, decidedAt: null, fundedAt: null, repaidAt: null,
        createdAt: new Date().toISOString(), ...row };
      requests.set(r.id, r);
      return copy(r);
    },
    async getRequest(id) { return copy(requests.get(id)); },
    async updateRequest(id, patch) {
      const r = requests.get(id);
      if (!r) return null;
      Object.assign(r, patchOnly(patch, REQUEST_PATCH));
      return copy(r);
    },
    async listRequestsByBorrowers(ids, { statuses } = {}) {
      return [...requests.values()].filter((r) => ids.includes(r.borrowerId) && (!statuses || statuses.includes(r.status))).sort((a, b) => b.id - a.id).slice(0, 100).map(copy);
    },
    async listRequestsByStatus(status) {
      return [...requests.values()].filter((r) => r.status === status).sort((a, b) => b.id - a.id).map(copy);
    },
    // Every request a member is part of: borrower, trusted contact, contributor, repayment payer or lender, or verifier.
    async listRequestsForMember(userId) {
      const ids = new Set();
      for (const r of requests.values()) if (r.borrowerId === userId || r.trustedContactId === userId) ids.add(r.id);
      for (const c of contributions.values()) if (c.contributorId === userId) ids.add(c.requestId);
      for (const p of repayments.values()) if (p.payerId === userId || p.lenderId === userId) ids.add(p.requestId);
      for (const v of verifications) if (v.verifierId === userId) ids.add(v.requestId);
      return [...ids].map((id) => requests.get(id)).sort((a, b) => b.id - a.id).map(copy);
    },
    async countActiveByBorrower(id) { return [...requests.values()].filter((r) => r.borrowerId === id && ACTIVE.includes(r.status)).length; },
    async countActiveAsContact(id) { return [...requests.values()].filter((r) => r.trustedContactId === id && ACTIVE.includes(r.status)).length; },

    // ---- verifications ----
    async listVerifications(requestId) { return verifications.filter((v) => v.requestId === requestId).map(copy); },
    async addVerification(row) {
      const i = verifications.findIndex((v) => v.requestId === row.requestId && v.verifierId === row.verifierId);
      const v = { createdAt: new Date().toISOString(), note: '', ...row };
      if (i >= 0) verifications[i] = v; else verifications.push(v);
    },

    // ---- help messages ----
    async addHelpMessage({ userId, body }) {
      const m = { id: nextId(), userId, body, createdAt: new Date().toISOString(), resolvedAt: null, assignedToId:null, assignedById:null, assignedAt:null };
      helpMessages.set(m.id, m);
      return copy(m);
    },
    async listHelpMessagesByUser(userId) {
      return [...helpMessages.values()].filter((m) => m.userId === userId).sort((a, b) => b.id - a.id).map(copy);
    },
    // Unresolved first, then resolved; oldest first within each group.
    async listHelpMessages() {
      return [...helpMessages.values()].sort((a, b) => (a.resolvedAt ? 1 : 0) - (b.resolvedAt ? 1 : 0) || a.id - b.id).map(copy);
    },
    async assignHelpMessage({ id, actorId, assigneeId }) {
      const actor=users.get(actorId), m=helpMessages.get(id), assignee=assigneeId===null?null:users.get(assigneeId);
      if (!actor?.isAdmin || actor.deletedAt) throw Object.assign(new Error('Admins only'),{code:'42501'});
      if (!m) throw Object.assign(new Error('Support message not found'),{code:'P0002'});
      if (assigneeId!==null && (!assignee || assignee.deletedAt || (!assignee.isAdmin && !assignee.isVerifier)))
        throw Object.assign(new Error('Assignee must be an active administrator or verifier'),{code:'23514'});
      const beforeState={assignedTo:m.assignedToId,assignedBy:m.assignedById,assignedAt:m.assignedAt};
      m.assignedToId=assigneeId; m.assignedById=actorId; m.assignedAt=assigneeId===null?null:new Date().toISOString();
      supportAuditEvents.push({id:supportAuditEvents.length+1,actorId,helpMessageId:id,eventType:assigneeId===null?'support.unassigned':'support.assigned',
        beforeState,afterState:{assignedTo:assigneeId,assignedBy:actorId,assignedAt:m.assignedAt},createdAt:new Date().toISOString()});
      return copy(m);
    },
    // Idempotent: an already resolved message keeps its first timestamp; only the first resolution is audited.
    async resolveHelpMessage(id, at, actorId) {
      const actor=users.get(actorId), m=helpMessages.get(id);
      if (!actor?.isAdmin || actor.deletedAt) throw Object.assign(new Error('Admins only'),{code:'42501'});
      if (!m) return null;
      if (!m.resolvedAt) {
        const beforeState={resolvedAt:null,assignedTo:m.assignedToId};
        m.resolvedAt=at;
        supportAuditEvents.push({id:supportAuditEvents.length+1,actorId,helpMessageId:id,eventType:'support.resolved',
          beforeState,afterState:{resolvedAt:at,assignedTo:m.assignedToId},createdAt:at});
      }
      return copy(m);
    },
    async listSupportAuditEvents({limit=100}={}) { return supportAuditEvents.slice().reverse().slice(0,Math.min(Math.max(limit,1),200)).map(copy); },

    // ---- contributions and repayments ----
    // Synchronous check-and-write sections mirror the Postgres request-row lock semantics in tests.
    async recordContribution({ requestId, contributorId, amountCents, utr = null, idempotencyKey }) {
      const key = `contribution.create:${contributorId}:${idempotencyKey}`;
      const hash = JSON.stringify({ requestId, contributorId, amountCents, utr });
      if (financialIdempotency.has(key)) {
        const saved = financialIdempotency.get(key);
        if (saved.hash !== hash) throw Object.assign(new Error('This idempotency key was already used for a different contribution'), { code: '22023' });
        return copy(saved.row);
      }
      const r = requests.get(requestId);
      if (!r || r.status !== 'open') throw Object.assign(new Error('This request is not accepting contributions'), { code: 'P0001' });
      if (contributorId === r.borrowerId) throw Object.assign(new Error('You cannot fund your own request'), { code: 'P0001' });
      const mutual = follows.some((f) => f.followerId === contributorId && f.followeeId === r.borrowerId)
        && follows.some((f) => f.followerId === r.borrowerId && f.followeeId === contributorId);
      if (!mutual) throw Object.assign(new Error('Only mutual connections can fund this request'), { code: 'P0001' });
      const reserved = [...contributions.values()].filter((c) => c.requestId === requestId && ['sent','confirmed'].includes(c.status)).reduce((n,c)=>n+c.amountCents,0);
      if (reserved + amountCents > r.principalCents) throw Object.assign(new Error(`Only ${Math.max(0,r.principalCents-reserved)} paise is still needed`), { code: 'P0001' });
      const row = { id: nextId(), requestId, contributorId, amountCents, utr, status: 'sent', createdAt: new Date().toISOString(), confirmedAt: null, updatedAt: null };
      contributions.set(row.id, row);
      financialIdempotency.set(key, { hash, row: copy(row) });
      return copy(row);
    },
    async recordRepayment({ requestId, payerId, lenderId, amountCents, utr = null, idempotencyKey }) {
      const key = `repayment.create:${payerId}:${idempotencyKey}`;
      const hash = JSON.stringify({ requestId, payerId, lenderId, amountCents, utr });
      if (financialIdempotency.has(key)) {
        const saved = financialIdempotency.get(key);
        if (saved.hash !== hash) throw Object.assign(new Error('This idempotency key was already used for a different repayment'), { code: '22023' });
        return copy(saved.row);
      }
      const r = requests.get(requestId);
      if (!r || r.status !== 'funded') throw Object.assign(new Error('Repayments can be recorded only for funded requests'), { code: 'P0001' });
      if (payerId !== r.borrowerId && payerId !== r.trustedContactId) throw Object.assign(new Error('Only the borrower or trusted contact can record a repayment'), { code: 'P0001' });
      if (!lenderId || lenderId === payerId) throw Object.assign(new Error('Choose a valid lender'), { code: 'P0001' });
      const lent = [...contributions.values()].filter((c)=>c.requestId===requestId && c.contributorId===lenderId && c.status==='confirmed').reduce((n,c)=>n+c.amountCents,0);
      const reserved = [...repayments.values()].filter((p)=>p.requestId===requestId && p.lenderId===lenderId && ['sent','confirmed'].includes(p.status)).reduce((n,p)=>n+p.amountCents,0);
      if (!lent) throw Object.assign(new Error('Unknown lender'), { code: 'P0001' });
      if (reserved + amountCents > lent) throw Object.assign(new Error(`Only ${Math.max(0,lent-reserved)} paise can still be repaid to this lender`), { code: 'P0001' });
      const row = { id: nextId(), requestId, payerId, lenderId, amountCents, utr, status: 'sent', createdAt: new Date().toISOString(), confirmedAt: null, updatedAt: null };
      repayments.set(row.id, row);
      financialIdempotency.set(key, { hash, row: copy(row) });
      return copy(row);
    },
    async reviseContribution({ entryId, actorId, amountCents, utr = null }) {
      const row = contributions.get(entryId);
      const r = row && requests.get(row.requestId);
      if (!row || !r) throw Object.assign(new Error('Contribution not found'), { code: 'P0001' });
      if (row.contributorId !== actorId) throw Object.assign(new Error('Only the person who sent this can change it'), { code: 'P0001' });
      if (row.status !== 'not_received') throw Object.assign(new Error('You can correct an entry only after the borrower marked it not received'), { code: 'P0001' });
      if (r.status !== 'open') throw Object.assign(new Error('This request is not accepting contributions'), { code: 'P0001' });
      const reserved = [...contributions.values()].filter((c)=>c.requestId===r.id && c.id!==entryId && ['sent','confirmed'].includes(c.status)).reduce((n,c)=>n+c.amountCents,0);
      if (reserved+amountCents>r.principalCents) throw Object.assign(new Error(`Only ${Math.max(0,r.principalCents-reserved)} paise is still needed`), { code: 'P0001' });
      Object.assign(row, { amountCents, utr, status: 'sent', updatedAt: new Date().toISOString() });
      return copy(row);
    },
    async reviseRepayment({ entryId, actorId, amountCents, utr = null }) {
      const row = repayments.get(entryId);
      const r = row && requests.get(row.requestId);
      if (!row || !r) throw Object.assign(new Error('Repayment not found'), { code: 'P0001' });
      if (row.payerId !== actorId) throw Object.assign(new Error('Only the person who sent this can change it'), { code: 'P0001' });
      if (row.status !== 'not_received') throw Object.assign(new Error('You can correct a repayment only after it was marked not received'), { code: 'P0001' });
      if (r.status !== 'funded') throw Object.assign(new Error('This request is not in repayment'), { code: 'P0001' });
      const lent = [...contributions.values()].filter((c)=>c.requestId===r.id && c.contributorId===row.lenderId && c.status==='confirmed').reduce((n,c)=>n+c.amountCents,0);
      const reserved = [...repayments.values()].filter((p)=>p.requestId===r.id && p.lenderId===row.lenderId && p.id!==entryId && ['sent','confirmed'].includes(p.status)).reduce((n,p)=>n+p.amountCents,0);
      if (!lent) throw Object.assign(new Error('Unknown lender'), { code: 'P0001' });
      if (reserved+amountCents>lent) throw Object.assign(new Error(`Only ${Math.max(0,lent-reserved)} paise can still be repaid to this lender`), { code: 'P0001' });
      Object.assign(row, { amountCents, utr, status: 'sent', updatedAt: new Date().toISOString() });
      return copy(row);
    },
    ...entryApi(contributions, 'addContribution', 'getContribution', 'updateContribution', 'deleteContribution', 'listContributions'),
    ...entryApi(repayments, 'addRepayment', 'getRepayment', 'updateRepayment', 'deleteRepayment', 'listRepayments'),
    _state: { users, follows, invites, requests, verifications, contributions, repayments, financialIdempotency },
  };
}

module.exports = { createMemoryRepo };
