'use strict';
// In-memory repository. Same contract as src/supabase-repo.js. Used by tests and local demos.
let seq = 0;
const nextId = () => ++seq;

function createMemoryRepo() {
  const users = new Map();          // id -> user
  const usersByClerk = new Map();   // clerkId -> id
  const follows = [];               // {followerId, followeeId}
  const invites = [];
  const requests = new Map();       // id -> request
  const verifications = [];         // {requestId, verifierId, decision, note}
  const contributions = [];         // {requestId, contributorId, amountCents}
  const repayments = [];            // {requestId, payerId, amountCents}
  const auditEvents = [];           // {actorId, action, subjectType, subjectId, detail, ip, createdAt}

  return {
    async upsertUser({ clerkId, name, email }) {
      let id = usersByClerk.get(clerkId);
      if (!id) {
        id = nextId();
        usersByClerk.set(clerkId, id);
        users.set(id, { id, clerkId, name, email, isVerifier: false });
      }
      return users.get(id);
    },
    async getUser(id) { return users.get(id) ?? null; },
    async setVerifier(id, isVerifier) { users.get(id).isVerifier = isVerifier; },
    async setPhone(id, phone) { users.get(id).phone = phone; return users.get(id); },
    async searchUsers(q, excludeId) {
      const s = q.toLowerCase();
      return [...users.values()].filter((u) => u.id !== excludeId && u.name.toLowerCase().includes(s));
    },
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
    async createRequest(row) { const r = { id: nextId(), status: 'pending_verification', createdAt: new Date().toISOString(), ...row }; requests.set(r.id, r); return r; },
    async getRequest(id) { return requests.get(id) ?? null; },
    async setRequestStatus(id, patch) { Object.assign(requests.get(id), patch); return requests.get(id); },
    async listFeed(borrowerIds) {
      return [...requests.values()].filter((r) => borrowerIds.includes(r.borrowerId)).sort((a, b) => b.id - a.id);
    },
    // Requests still awaiting a verification decision, oldest first.
    // excludeDecidedBy: skip requests this verifier already decided on.
    async listPendingRequests({ excludeDecidedBy } = {}) {
      const decided = new Set(verifications.filter((v) => v.verifierId === excludeDecidedBy).map((v) => v.requestId));
      return [...requests.values()].filter((r) => r.status === 'pending_verification' && !decided.has(r.id)).sort((a, b) => a.id - b.id);
    },
    async listVerifications(requestId) { return verifications.filter((v) => v.requestId === requestId); },
    // Every request a member is part of: as borrower or nominee, or with a contribution, repayment or decision.
    async listRequestsForMember(userId) {
      const ids = new Set();
      for (const r of requests.values()) if (r.borrowerId === userId || r.nomineeId === userId) ids.add(r.id);
      for (const c of contributions) if (c.contributorId === userId) ids.add(c.requestId);
      for (const p of repayments) if (p.payerId === userId) ids.add(p.requestId);
      for (const v of verifications) if (v.verifierId === userId) ids.add(v.requestId);
      return [...ids].map((id) => requests.get(id)).sort((a, b) => b.id - a.id);
    },
    async addVerification(row) {
      const i = verifications.findIndex((v) => v.requestId === row.requestId && v.verifierId === row.verifierId);
      if (i >= 0) verifications[i] = row; else verifications.push(row);
    },
    async listContributions(requestId) { return contributions.filter((c) => c.requestId === requestId); },
    async addContribution(row) { contributions.push(row); },
    // Same contract as the Postgres function: single-threaded here, so the check and insert cannot interleave.
    async addContributionAtomic({ requestId, contributorId, amountCents, idempotencyKey = null, createdAt }) {
      const r = requests.get(requestId);
      if (!r) return { ok: false, reason: 'not_found' };
      if (idempotencyKey) {
        const prior = contributions.find((c) => c.contributorId === contributorId && c.idempotencyKey === idempotencyKey);
        if (prior) return { ok: true, duplicate: true, contributionId: prior.id };
      }
      if (r.borrowerId === contributorId) return { ok: false, reason: 'own_request' };
      if (r.status !== 'open') return { ok: false, reason: 'not_open' };
      const raised = contributions.filter((c) => c.requestId === requestId).reduce((s, c) => s + c.amountCents, 0);
      if (amountCents > r.principalCents - raised) {
        return { ok: false, reason: 'over_cap', remainingCents: Math.max(0, r.principalCents - raised) };
      }
      const id = nextId();
      contributions.push({ id, requestId, contributorId, amountCents, idempotencyKey, createdAt });
      const funded = raised + amountCents >= r.principalCents;
      if (funded) Object.assign(r, { status: 'funded', fundedAt: createdAt });
      return { ok: true, duplicate: false, contributionId: id, funded };
    },
    async anonymizeUser(id) {
      const u = users.get(id);
      if (!u) return;
      usersByClerk.delete(u.clerkId);
      Object.assign(u, { clerkId: `deleted-${id}`, name: 'Deleted member', email: `deleted-${id}@deleted.invalid`, phone: null, isVerifier: false });
      for (let i = follows.length - 1; i >= 0; i--) {
        if (follows[i].followerId === id || follows[i].followeeId === id) follows.splice(i, 1);
      }
      for (let i = invites.length - 1; i >= 0; i--) if (invites[i].inviterId === id) invites.splice(i, 1);
      for (const e of auditEvents) if (e.actorId === id) e.ip = null;
    },
    async listRepayments(requestId) { return repayments.filter((p) => p.requestId === requestId); },
    async addRepayment(row) { repayments.push(row); },
    async recordEvent(row) { auditEvents.push({ createdAt: new Date().toISOString(), ...row }); },
    async addInvite(row) { invites.push({ email: null, acceptedAt: null, ...row }); },
    async getInviteByToken(token) { return invites.find((i) => i.token === token) ?? null; },
    async markInviteAccepted(token, at) { const i = invites.find((x) => x.token === token); if (i && !i.acceptedAt) i.acceptedAt = at; },
    // Every follow where either side is one of the given members.
    async followsTouching(userIds) {
      const ids = new Set(userIds);
      return follows.filter((f) => ids.has(f.followerId) || ids.has(f.followeeId)).map((f) => ({ ...f }));
    },
    _state: { users, follows, invites, requests, verifications, contributions, repayments, auditEvents },
  };
}

module.exports = { createMemoryRepo };
