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

const USER_PATCH = ['name', 'upiId', 'avatarUrl', 'welcomedAt', 'termsAcceptedAt'];
const INVITE_PATCH = ['acceptedAt', 'acceptedUserId', 'revokedAt', 'supersededAt'];
const REQUEST_PATCH = ['status', 'decidedAt', 'fundedAt', 'repaidAt', 'fundedCents', 'rejectionReason', 'repaymentDate',
  'originalRepaymentDate', 'withdrawnAt', 'contactDecidedAt', 'category', 'purpose'];
const ENTRY_PATCH = ['status', 'utr', 'amountCents', 'confirmedAt', 'updatedAt', 'settledBy', 'settledNote', 'settledAt', 'helpRequestedAt'];

function createMemoryRepo() {
  const users = new Map();          // id -> user
  const follows = [];               // {followerId, followeeId}
  const invites = new Map();
  const requests = new Map();
  const verifications = [];         // {requestId, verifierId, decision, note, createdAt}
  const contributions = new Map();
  const repayments = new Map();

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
    async setVerifier(id, isVerifier) { users.get(id).isVerifier = !!isVerifier; },
    async searchUsers(q, excludeId) {
      const s = q.toLowerCase();
      return [...users.values()].filter((u) => u.id !== excludeId && (u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s))).slice(0, 20).map(copy);
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
    async listRequestsByBorrowers(ids) {
      return [...requests.values()].filter((r) => ids.includes(r.borrowerId)).sort((a, b) => b.id - a.id).slice(0, 100).map(copy);
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

    // ---- contributions and repayments ----
    ...entryApi(contributions, 'addContribution', 'getContribution', 'updateContribution', 'deleteContribution', 'listContributions'),
    ...entryApi(repayments, 'addRepayment', 'getRepayment', 'updateRepayment', 'deleteRepayment', 'listRepayments'),
    _state: { users, follows, invites, requests, verifications, contributions, repayments },
  };
}

module.exports = { createMemoryRepo };
