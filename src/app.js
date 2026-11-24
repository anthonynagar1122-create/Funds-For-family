'use strict';
const express = require('express');
const rules = require('./rules');
const invites = require('./invites');
const { formatInr, parseRupees } = require('../public/app/money');

const UPI_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/;

// Path ids must be plain digits that fit a safe integer. Anything else is "not found", never a database error.
function parseId(raw) {
  const text = String(raw ?? '');
  if (!/^\d{1,15}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

const INVITE_ONLY = {
  error: 'Funds For Family is invite only. Ask someone who uses it to send you an invite.',
  code: 'invite_only',
};

/**
 * Build the Express API.
 * deps:
 *   repo        data access (see src/memory-repo.js for the contract; src/supabase-repo.js in production)
 *   identify    async (req) => { clerkId, name, email } | null   (Clerk in production)
 *   mailer      async ({ to, subject, html }) => void            (Resend in production)
 *   now         () => Date
 *   appUrl      string, used in email links
 *   ownerEmail  string; the member with this email is admitted as admin and verifier
 *   admit       async (identity) => boolean; extra admission rule, default none (invite only)
 *   requiredApprovals number, default rules.DEFAULT_REQUIRED_APPROVALS
 */
function createApp({ repo, identify, mailer = async () => {}, now = () => new Date(), appUrl = 'http://localhost:3000',
  requiredApprovals = rules.DEFAULT_REQUIRED_APPROVALS, logger = console, ownerEmail = '', admit = async () => false }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  const fail = (res, status, error, field) => res.status(status).json(field ? { error, field } : { error });

  const safeMail = async (msg) => {
    try { await mailer(msg); } catch (err) { logger.error('mail failed', err?.message); }
  };

  const appLink = () => `<a href="${escapeHtml(appUrl.replace(/\/+$/, '') + '/app/')}">open Funds For Family</a>`;

  // Why a new person may join, or null. Never trusts the repo for expiry: inviteState uses the injected clock.
  async function admissionFor(req, identity) {
    const email = String(identity.email ?? '').trim().toLowerCase();
    if (ownerEmail && email && email === ownerEmail.trim().toLowerCase()) return { via: 'owner' };
    const asOf = now();
    const raw = req.get('x-invite-token');
    if (raw) {
      const byToken = await repo.findInviteByHash(invites.hashToken(raw));
      if (byToken && invites.inviteState(byToken, asOf) === 'open') return { via: 'invite', invite: byToken };
    }
    if (email) {
      const usable = (await repo.findOpenInvitesByEmail(email)).filter((i) => invites.inviteState(i, asOf) === 'open');
      if (usable.length) return { via: 'invite', invite: usable.sort((x, y) => x.id - y.id)[0] };
    }
    if (await admit(identity)) return { via: 'admit' };
    return null;
  }

  // Runs only when a NEW member was created by an invite (the invite itself was claimed before the member was made).
  async function acceptInvite(invite, user, email) {
    const asOf = now();
    await repo.updateInvite(invite.id, { acceptedUserId: user.id });
    if (await repo.getUser(invite.inviterId)) {
      await repo.addFollow(invite.inviterId, user.id);
      await repo.addFollow(user.id, invite.inviterId);
    }
    if (email) {
      for (const other of await repo.findOpenInvitesByEmail(email)) {
        if (other.id !== invite.id && invites.inviteState(other, asOf) === 'open') {
          await repo.updateInvite(other.id, { supersededAt: asOf.toISOString() });
        }
      }
    }
  }

  // Resolve the signed-in user. Joining is invite only: a new person is created only when admissionFor allows it.
  async function requireUser(req, res, next) {
    try {
      const identity = await identify(req);
      if (!identity?.clerkId) return fail(res, 401, 'Sign in required');
      const verifiedEmail = String(identity.email ?? '').trim().toLowerCase();
      const isOwnerEmail = Boolean(ownerEmail && verifiedEmail && verifiedEmail === ownerEmail.trim().toLowerCase());
      let user = await repo.findUserByClerkId(identity.clerkId);
      if (user && isOwnerEmail && !user.isAdmin) {
        user = (await repo.updateUser(user.id, { isAdmin: true, isVerifier: true })) ?? user;
      }
      if (!user) {
        const admission = await admissionFor(req, identity);
        if (!admission) return res.status(403).json(INVITE_ONLY);
        // The users table needs an email, and only a verified one is trusted.
        if (!verifiedEmail) {
          return res.status(403).json({ error: 'Verify your email address, then try again.', code: 'email_unverified' });
        }
        const owner = admission.via === 'owner';
        if (admission.via === 'invite') {
          const claimed = await repo.claimInvite(admission.invite.id, { acceptedAt: now().toISOString() });
          if (!claimed) {
            // Lost the claim. If the same person's first request already created the row, carry on as that member.
            user = await repo.findUserByClerkId(identity.clerkId);
            if (!user) return res.status(403).json(INVITE_ONLY);
          }
        }
        if (!user) {
          let created = true;
          try {
            user = await repo.createUser({
              clerkId: identity.clerkId, name: identity.name || 'Member', email: identity.email,
              avatarUrl: identity.avatarUrl ?? null, isAdmin: owner, isVerifier: owner,
            });
          } catch (err) {
            // A concurrent first request may have created the row (unique clerk_id). Use it if it is there.
            user = await repo.findUserByClerkId(identity.clerkId);
            if (!user) {
              // Nobody was created: give the claimed invite back so it can still be used.
              if (admission.via === 'invite') await repo.updateInvite(admission.invite.id, { acceptedAt: null }).catch(() => {});
              throw err;
            }
            created = false;
          }
          if (created && admission.via === 'invite') await acceptInvite(admission.invite, user, verifiedEmail);
        }
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  const api = express.Router();

  // Express 4 does not catch promise rejections from async handlers. Route them to the error handler,
  // so a failing dependency returns a generic 500 instead of hanging the request.
  const wrapAsync = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
  for (const method of ['get', 'post', 'patch', 'delete']) {
    const original = api[method].bind(api);
    api[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((h) =>
      h.constructor.name === 'AsyncFunction' ? wrapAsync(h) : h));
  }
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use(requireUser);

  api.get('/me', (req, res) => res.json({ user: publicUser(req.user, req.user.id) }));

  api.patch('/me', async (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (name.length < 1 || name.length > 120) return fail(res, 400, 'Your name must be 1 to 120 characters', 'name');
      patch.name = name;
    }
    if (req.body?.upiId !== undefined) {
      const upi = typeof req.body.upiId === 'string' ? req.body.upiId.trim() : null;
      if (upi === null || (upi !== '' && !UPI_PATTERN.test(upi))) {
        return fail(res, 400, 'Enter a valid UPI ID, like name@bank', 'upiId');
      }
      patch.upiId = upi === '' ? null : upi;
    }
    const updated = Object.keys(patch).length ? await repo.updateUser(req.user.id, patch) : req.user;
    res.json({ user: publicUser(updated, req.user.id) });
  });

  api.post('/me/accept-terms', async (req, res) => {
    const updated = await repo.updateUser(req.user.id, { termsAcceptedAt: now().toISOString() });
    res.json({ user: publicUser(updated, req.user.id) });
  });

  api.post('/me/welcomed', async (req, res) => {
    const updated = await repo.updateUser(req.user.id, { welcomedAt: now().toISOString() });
    res.json({ user: publicUser(updated, req.user.id) });
  });

  // Empty query returns your mutual connections (used for the trusted-contact picker). Two or more characters searches all members.
  api.get('/users', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length === 0) {
      const conn = await repo.connections(req.user.id);
      const ids = conn.following.filter((id) => rules.isMutual(conn, id));
      const users = await repo.getUsers(ids);
      return res.json({ users: users.map((u) => publicUser(u, req.user.id)) });
    }
    if (q.length < 2) return res.json({ users: [] });
    const users = await repo.searchUsers(q, req.user.id);
    res.json({ users: users.slice(0, 20).map((u) => publicUser(u, req.user.id)) });
  });

  api.get('/users/:id', async (req, res) => {
    const uid = parseId(req.params.id);
    const u = uid === null ? null : await repo.getUser(uid);
    if (!u) return fail(res, 404, 'User not found');
    res.json({ user: publicUser(u, req.user.id) });
  });

  api.post('/follows', async (req, res) => {
    const followeeId = Number(req.body?.userId);
    if (!Number.isInteger(followeeId)) return fail(res, 400, 'userId is required', 'userId');
    if (followeeId === req.user.id) return fail(res, 400, 'You cannot follow yourself', 'userId');
    if (!(await repo.getUser(followeeId))) return fail(res, 404, 'User not found');
    await repo.addFollow(req.user.id, followeeId);
    res.status(201).json({ ok: true });
  });

  api.delete('/follows/:userId', async (req, res) => {
    const followeeId = parseId(req.params.userId);
    if (followeeId === null) return fail(res, 404, 'User not found');
    await repo.removeFollow(req.user.id, followeeId);
    res.json({ ok: true });
  });

  api.get('/connections', async (req, res) => {
    const { following, followers } = await repo.connections(req.user.id);
    const followingSet = new Set(following);
    const mutualIds = followers.filter((id) => followingSet.has(id));
    const load = async (ids) => Promise.all(ids.map((id) => repo.getUser(id).then((u) => publicUser(u, req.user.id))));
    res.json({ following: await load(following), followers: await load(followers), mutual: await load(mutualIds) });
  });

  api.post('/invites', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email', 'email');
    if (email === String(req.user.email ?? '').toLowerCase() || (await repo.findUserByEmail(email))) {
      return fail(res, 409, 'This person is already a member', 'email');
    }
    const limit = req.user.inviteLimit ?? invites.DEFAULT_MONTHLY_INVITES;
    const used = await repo.countInvitesSince(req.user.id, invites.monthStartIst(now()));
    if (used >= limit) return fail(res, 429, 'You have used all your invites this month');
    const { token, tokenHash } = invites.newToken();
    const created = await repo.createInvite({
      inviterId: req.user.id, email, tokenHash,
      expiresAt: new Date(now().getTime() + invites.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now().toISOString(),
    });
    const link = `${appUrl.replace(/\/+$/, '')}/app/#join=${token}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${req.user.name} invited you to join Funds For Family: ${link}`)}`;
    await safeMail({
      to: email,
      subject: `${req.user.name} invited you to Funds For Family`,
      html: `<p>${escapeHtml(req.user.name)} invited you to join Funds For Family.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a></p>`,
    });
    res.status(201).json({
      invite: { id: created.id, email, expiresAt: created.expiresAt },
      link, whatsappUrl, remainingThisMonth: limit - used - 1,
    });
  });

  api.get('/invites', async (req, res) => {
    const asOf = now();
    const mine = await repo.listInvitesByInviter(req.user.id);
    res.json({ invites: mine.map((i) => ({
      id: i.id, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt, state: invites.inviteState(i, asOf),
    })) });
  });

  api.delete('/invites/:id', async (req, res) => {
    const inviteId = parseId(req.params.id);
    const invite = inviteId === null ? null : await repo.getInvite(inviteId);
    if (!invite || invite.inviterId !== req.user.id) return fail(res, 404, 'Invite not found');
    if (invite.acceptedAt) return fail(res, 409, 'This invite has already been used');
    if (!invite.revokedAt) await repo.updateInvite(invite.id, { revokedAt: now().toISOString() });
    res.json({ ok: true });
  });

  // Your own requests (any status) plus those of mutual connections once open, funded or repaid.
  api.get('/feed', async (req, res) => {
    const conn = await repo.connections(req.user.id);
    const mutualIds = conn.following.filter((id) => rules.isMutual(conn, id));
    const [own, theirs] = await Promise.all([
      repo.listRequestsByBorrowers([req.user.id]),
      repo.listRequestsByBorrowers(mutualIds, { statuses: ['open', 'funded', 'repaid'] }),
    ]);
    const rows = [...own, ...theirs].sort((a, b) => b.id - a.id);
    const items = await Promise.all(rows.map(async (r) => {
      const totals = rules.fundingTotals(await repo.listContributions(r.id));
      return { ...summarise(r, now(), req.user.id), totals, raisedCents: totals.confirmedCents };
    }));
    res.json({ requests: items });
  });

  // What needs the caller's attention, plus their requests and their lending.
  api.get('/home', async (req, res) => {
    const me = req.user.id;
    const asOf = now();
    const mine = await repo.listRequestsForMember(me);
    const seen = new Set(mine.map((r) => r.id));
    const needsYou = [];
    const myRequests = [];
    const myLending = [];
    for (const r of mine) {
      const [contribs, repays, verifs] = await Promise.all([repo.listContributions(r.id), repo.listRepayments(r.id), repo.listVerifications(r.id)]);
      const totals = rules.fundingTotals(contribs);
      const need = (kind, extra = {}) => needsYou.push({ kind, requestId: r.id, ...extra });
      if (r.borrowerId === me) {
        myRequests.push({ ...summarise(r, asOf, me), totals, raisedCents: totals.confirmedCents });
        if (r.status === 'contact_declined') need('repick_contact');
        if (r.status === 'open') {
          for (const c of contribs.filter((x) => x.status === 'sent')) {
            need('confirm_contribution', { entryId: c.id, amountCents: c.amountCents, fromUserId: c.contributorId });
          }
        }
      }
      if (r.trustedContactId === me && r.status === 'awaiting_contact') need('contact_decision');
      if (r.status === 'pending_verification' && req.user.isVerifier && r.borrowerId !== me && r.trustedContactId !== me
        && !verifs.some((v) => v.verifierId === me)) need('verify');
      for (const c of contribs.filter((x) => x.contributorId === me && x.status === 'not_received')) {
        need('fix_contribution', { entryId: c.id, amountCents: c.amountCents });
      }
      for (const p of repays) {
        if (p.lenderId === me && p.status === 'sent') need('confirm_repayment', { entryId: p.id, amountCents: p.amountCents, fromUserId: p.payerId });
        if (p.payerId === me && p.status === 'not_received') need('fix_repayment', { entryId: p.id, amountCents: p.amountCents });
      }
      if (contribs.some((c) => c.contributorId === me)) {
        const owed = rules.owedByLender(contribs.map((c) => ({ ...c, lenderId: c.contributorId })), repays).get(me)
          ?? { lentCents: 0, repaidCents: 0, pendingRepayCents: 0, owedCents: 0 };
        myLending.push({ ...summarise(r, asOf, me), totals, myLentCents: owed.lentCents, myRepaidCents: owed.repaidCents, myOwedCents: owed.owedCents });
      }
    }
    // A verifier also sees requests waiting for a decision they have not made.
    if (req.user.isVerifier) {
      for (const r of await repo.listRequestsByStatus('pending_verification')) {
        if (seen.has(r.id) || r.borrowerId === me || r.trustedContactId === me) continue;
        needsYou.push({ kind: 'verify', requestId: r.id });
      }
    }
    res.json({ needsYou, myRequests, myLending });
  });

  // The member's ledger. Built from every request they take part in (listRequestsForMember): as borrower, trusted
  // contact, lender, repayment payer or lender, or verifier.
  api.get('/activity', async (req, res) => {
    const me = req.user.id;
    const asOf = now();
    const requests = await repo.listRequestsForMember(me);
    const details = await Promise.all(requests.map(async (r) => ({
      r,
      verifs: await repo.listVerifications(r.id),
      contribs: await repo.listContributions(r.id),
      repays: await repo.listRepayments(r.id),
    })));
    const total = (list) => list.reduce((s, x) => s + x.amountCents, 0);
    const row = (r, myRole, myAmountCents) => ({
      requestId: r.id,
      purpose: r.purpose,
      status: rules.effectiveStatus(r, asOf),
      principalCents: r.principalCents,
      repaymentDate: r.repaymentDate,
      myRole,
      myAmountCents,
    });
    const out = { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { trustedContact: [], verifier: [] } };
    for (const { r, verifs, contribs, repays } of details) {
      const confirmedRepays = repays.filter((p) => p.status === 'confirmed');
      const myPaid = total(confirmedRepays.filter((p) => p.payerId === me));
      const myLent = total(contribs.filter((c) => c.contributorId === me && c.status === 'confirmed'));
      const myReceived = total(confirmedRepays.filter((p) => p.lenderId === me));
      if (r.borrowerId === me) out.borrowing.push(row(r, 'borrower', myPaid));
      if (myLent > 0) {
        out.lending.push(row(r, 'lender', myLent));
        if (myReceived > 0) out.repayments.received.push(row(r, 'lender', myReceived));
      }
      if (myPaid > 0) out.repayments.made.push(row(r, 'payer', myPaid));
      if (r.trustedContactId === me) out.roles.trustedContact.push(row(r, 'trustedContact', 0));
      if (verifs.some((v) => v.verifierId === me)) out.roles.verifier.push(row(r, 'verifier', 0));
    }
    res.json(out);
  });

  // Load a request and refuse (404) unless the caller may see it. Returns null after responding.
  async function visibleRequest(req, res, rawId = req.params.id) {
    const id = parseId(rawId);
    const r = id !== null ? await repo.getRequest(id) : null;
    if (!r) { fail(res, 404, 'Request not found'); return null; }
    const me = req.user;
    const [conn, contribs] = await Promise.all([repo.connections(me.id), repo.listContributions(r.id)]);
    const seen = rules.canSeeRequest({
      viewerId: me.id, request: r,
      isMutualWithBorrower: rules.isMutual(conn, r.borrowerId),
      isLender: contribs.some((c) => c.contributorId === me.id),
      viewerIsVerifier: !!me.isVerifier,
    });
    if (!seen) { fail(res, 404, 'Request not found'); return null; }
    return r;
  }

  // Checks for naming a trusted contact. Returns an error { status, error, field } or null.
  async function contactProblem(borrowerId, contactId) {
    if (!Number.isInteger(contactId) || !(await repo.getUser(contactId))) {
      return { status: 400, error: 'Choose a trusted contact', field: 'trustedContactId' };
    }
    const check = rules.checkTrustedContact({
      borrowerId, contactId,
      isMutual: rules.isMutual(await repo.connections(borrowerId), contactId),
      contactActiveCount: await repo.countActiveAsContact(contactId),
    });
    return check.ok ? null : { status: 409, error: check.reason, field: 'trustedContactId' };
  }

  async function mailTrustedContact(borrower, contactId, r) {
    const contact = await repo.getUser(contactId);
    if (!contact?.email) return;
    const link = `${appUrl.replace(/\/+$/, '')}/app/`;
    await safeMail({
      to: contact.email,
      subject: `${borrower.name} named you as their trusted contact`,
      html: `<p>${escapeHtml(borrower.name)} asked for ${formatInr(r.principalCents)} and named you as their trusted contact.</p>`
        + `<p>Please accept or decline in the app: <a href="${escapeHtml(link)}">open Funds For Family</a>.</p>`,
    });
  }

  api.post('/requests', async (req, res) => {
    const { errors, value } = rules.validateRequest(req.body, { borrowerId: req.user.id, now: now() });
    const first = Object.keys(errors)[0];
    if (first) return fail(res, 400, errors[first], first);
    const active = rules.checkCanCreateRequest({ borrowerActiveCount: await repo.countActiveByBorrower(req.user.id) });
    if (!active.ok) return fail(res, 409, active.reason);
    const problem = await contactProblem(req.user.id, value.trustedContactId);
    if (problem) return fail(res, problem.status, problem.error, problem.field);
    let created;
    try {
      created = await repo.createRequest({
        borrowerId: req.user.id,
        trustedContactId: value.trustedContactId,
        purpose: value.purpose,
        category: value.category,
        principalCents: value.principalCents,
        repaymentDate: value.repaymentDate,
        status: 'awaiting_contact',
        createdAt: now().toISOString(),
      });
    } catch (err) {
      // The one-active-request unique index fired: a double submit. Answer as the normal rule would.
      if (err?.code === '23505') return fail(res, 409, rules.checkCanCreateRequest({ borrowerActiveCount: 1 }).reason);
      throw err;
    }
    await mailTrustedContact(req.user, value.trustedContactId, created);
    res.status(201).json({ request: summarise(created, now(), req.user.id) });
  });

  api.get('/requests/:id', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (r) res.json({ request: await detail(r, req.user.id) });
  });

  api.post('/requests/:id/contact-decision', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    if (r.trustedContactId !== req.user.id) return fail(res, 403, 'Only the trusted contact can answer this');
    const decision = req.body?.decision;
    if (decision !== 'accept' && decision !== 'decline') return fail(res, 400, 'decision must be accept or decline', 'decision');
    if (r.status !== 'awaiting_contact') return fail(res, 409, 'This request is not waiting for your answer');
    await repo.updateRequest(r.id, {
      status: decision === 'accept' ? 'pending_verification' : 'contact_declined',
      contactDecidedAt: now().toISOString(),
    });
    res.json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/requests/:id/trusted-contact', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    if (r.borrowerId !== req.user.id) return fail(res, 403, 'Only the borrower can choose a trusted contact');
    if (r.status !== 'contact_declined') return fail(res, 409, 'You can choose a new trusted contact only after the first one declined');
    const contactId = Number(req.body?.userId);
    if (contactId === r.trustedContactId) {
      return fail(res, 409, 'Choose someone other than the person who declined', 'trustedContactId');
    }
    const problem = await contactProblem(req.user.id, contactId);
    if (problem) return fail(res, problem.status, problem.error, problem.field);
    const updated = await repo.updateRequest(r.id, { trustedContactId: contactId, status: 'awaiting_contact', contactDecidedAt: null });
    await mailTrustedContact(req.user, contactId, updated);
    res.json({ request: await detail(updated, req.user.id) });
  });

  api.post('/requests/:id/verify', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    const { errors, value } = rules.validateVerification({ decision: req.body?.decision, reason: req.body?.reason ?? req.body?.note });
    const first = Object.keys(errors)[0];
    if (first) return fail(res, 400, errors[first], first);
    const check = rules.canVerify({ verifier: req.user, borrowerId: r.borrowerId, trustedContactId: r.trustedContactId, status: r.status });
    if (!check.ok) return fail(res, 403, check.reason);
    await repo.addVerification({ requestId: r.id, verifierId: req.user.id, decision: value.decision, note: value.reason ?? '', createdAt: now().toISOString() });
    const outcome = rules.verificationOutcome(await repo.listVerifications(r.id), requiredApprovals);
    if (outcome !== 'pending') {
      const approved = outcome === 'approved';
      const patch = { status: approved ? 'open' : 'rejected', decidedAt: now().toISOString() };
      let reason = '';
      if (!approved) {
        reason = value.reason ?? (await repo.listVerifications(r.id)).find((v) => v.decision === 'reject')?.note ?? '';
        patch.rejectionReason = reason;
      }
      await repo.updateRequest(r.id, patch);
      // The decision is saved. A failed lookup or email must not turn it into a 500.
      await mailLender(r.borrowerId,
        approved ? 'Your Funds For Family request was approved' : 'Your Funds For Family request was not approved',
        approved
          ? `<p>Your request for ${formatInr(r.principalCents)} was <strong>approved and is open for funding</strong>.</p>`
          : `<p>Your request for ${formatInr(r.principalCents)} was <strong>not approved</strong> by the verification team.</p><p>Reason: ${escapeHtml(reason)}</p>`);
    }
    res.json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/requests/:id/withdraw', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    if (r.borrowerId !== req.user.id) return fail(res, 403, 'Only the borrower can withdraw this request');
    if (!['awaiting_contact', 'contact_declined', 'pending_verification', 'open'].includes(r.status)) {
      return fail(res, 409, 'This request can no longer be withdrawn');
    }
    const { confirmedCents } = rules.fundingTotals(await repo.listContributions(r.id));
    if (confirmedCents > 0) return fail(res, 409, 'Someone has already lent money on this request, so it cannot be withdrawn');
    await repo.updateRequest(r.id, { status: 'withdrawn', withdrawnAt: now().toISOString() });
    await mailSentLenders(r, 'withdrawn');
    res.json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/requests/:id/close', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    if (r.borrowerId !== req.user.id) return fail(res, 403, 'Only the borrower can close this request');
    if (r.status !== 'open') return fail(res, 409, 'Only an open request can be closed');
    const { confirmedCents } = rules.fundingTotals(await repo.listContributions(r.id));
    if (confirmedCents <= 0) return fail(res, 409, 'Nothing has been lent yet. Withdraw the request instead.');
    await repo.updateRequest(r.id, { status: 'funded', fundedCents: confirmedCents, fundedAt: now().toISOString() });
    await mailSentLenders(r, 'closed');
    res.json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  // ---- Contributions: the lender marks "sent", the borrower confirms "received" ----
  const contributionJson = (c) => ({
    id: c.id, requestId: c.requestId, contributorId: c.contributorId, amountCents: c.amountCents,
    utr: c.utr ?? null, status: c.status, createdAt: c.createdAt, confirmedAt: c.confirmedAt ?? null,
  });

  // Parses an optional UTR from a body. Returns { utr } (null when empty) or { error }.
  function readUtr(body) {
    const raw = body?.utr;
    if (raw === undefined || raw === null || raw === '') return { utr: null };
    const text = typeof raw === 'string' ? raw.trim() : raw;
    return rules.validateUtr(text) ? { utr: text } : { error: 'A UPI reference is 6 to 35 letters or digits' };
  }

  // Load an entry (contribution or repayment) on a request the caller can see (404 otherwise).
  // Returns { entry, r } or null after responding.
  async function loadEntry(req, res, getter, label) {
    const id = parseId(req.params.id);
    const entry = id !== null ? await getter(id) : null;
    if (!entry) { fail(res, 404, `${label} not found`); return null; }
    const r = await visibleRequest(req, res, entry.requestId);
    if (!r) return null;
    return { entry, r };
  }

  // Parses a correction body: a new amount and/or UPI reference. Returns { patch, amountCents } or { error, field }.
  function readEntryPatch(body, currentCents) {
    const hasAmount = body?.amount !== undefined;
    const hasUtr = body?.utr !== undefined;
    if (!hasAmount && !hasUtr) return { error: 'Give a new amount or UPI reference', field: 'amount' };
    const patch = { status: 'sent', updatedAt: now().toISOString() };
    let amountCents = currentCents;
    if (hasAmount) {
      const parsed = parseRupees(body.amount);
      if (parsed.error) return { error: parsed.error, field: 'amount' };
      amountCents = parsed.paise;
      patch.amountCents = amountCents;
    }
    if (hasUtr) {
      const u = readUtr(body);
      if (u.error) return { error: u.error, field: 'utr' };
      patch.utr = u.utr;
    }
    return { patch, amountCents };
  }

  // Never lets an email problem fail a change that is already saved.
  async function mailLender(lenderId, subject, html) {
    try {
      const lender = await repo.getUser(lenderId);
      if (lender?.email) await safeMail({ to: lender.email, subject, html });
    } catch (err) { logger.error('mail failed', err?.message); }
  }

  // Tell every lender with a "sent" entry that it is not counted (request withdrawn or closed).
  async function mailSentLenders(r, verb) {
    let sentRows = [];
    try { sentRows = (await repo.listContributions(r.id)).filter((c) => c.status === 'sent'); } catch (err) { logger.error('mail failed', err?.message); }
    for (const c of sentRows) {
      await mailLender(c.contributorId, `A request you sent money to was ${verb}`,
        `<p>The request you sent ${formatInr(c.amountCents)} to was ${verb}. Your ${formatInr(c.amountCents)} marked as sent is not counted.</p>`
        + `<p>You can remove it in the app: ${appLink()}.</p>`);
    }
  }

  // Race guard. Two requests can both pass the cap check before either writes. After writing, re-read the rows in
  // id order (first come, first served); if our own row now sits over the cap it loses. Returns the 409 message or null.
  async function contributionOverCap(r, rowId) {
    const rows = await repo.listContributions(r.id);
    if (!rules.exceedsCapAtRow(rows, rowId, r.principalCents)) return null;
    const others = rules.fundingTotals(rows.filter((x) => x.id !== rowId));
    return `Only ${formatInr(Math.max(0, r.principalCents - others.confirmedCents - others.pendingCents))} is still needed`;
  }

  async function repaymentOverCap(r, lenderId, rowId) {
    const owed = (await owedFor(r.id)).get(lenderId);
    const rows = (await repo.listRepayments(r.id)).filter((x) => x.lenderId === lenderId);
    if (!rules.exceedsCapAtRow(rows, rowId, owed?.lentCents ?? 0)) return null;
    const others = rows.filter((x) => x.id !== rowId && (x.status === 'sent' || x.status === 'confirmed')).reduce((t, x) => t + x.amountCents, 0);
    return `Only ${formatInr(Math.max(0, (owed?.lentCents ?? 0) - others))} can still be repaid to this lender`;
  }

  // A confirmation can be retried after the request update failed, so every confirm re-checks the transition.
  async function settleFunded(requestId) {
    const { confirmedCents } = rules.fundingTotals(await repo.listContributions(requestId));
    const current = await repo.getRequest(requestId);
    if (confirmedCents >= current.principalCents && current.status === 'open') {
      await repo.updateRequest(requestId, { status: 'funded', fundedCents: current.principalCents, fundedAt: now().toISOString() });
    }
  }

  async function settleRepaid(requestId) {
    const current = await repo.getRequest(requestId);
    if (current.status === 'funded' && rules.isFullyRepaid(await owedFor(requestId))) {
      await repo.updateRequest(requestId, { status: 'repaid', repaidAt: now().toISOString() });
    }
  }

  api.post('/requests/:id/contributions', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    const mutual = rules.isMutual(await repo.connections(req.user.id), r.borrowerId);
    const parsed = parseRupees(req.body?.amount);
    if (parsed.error) return fail(res, 400, parsed.error, 'amount');
    const u = readUtr(req.body);
    if (u.error) return fail(res, 400, u.error, 'utr');
    const totals = rules.fundingTotals(await repo.listContributions(r.id));
    const check = rules.checkContribution({
      amountCents: parsed.paise, principalCents: r.principalCents, totals,
      contributorId: req.user.id, borrowerId: r.borrowerId, isMutual: mutual, status: r.status,
    });
    if (!check.ok) return fail(res, 409, check.reason);
    const created = await repo.addContribution({
      requestId: r.id, contributorId: req.user.id, amountCents: parsed.paise, utr: u.utr,
      status: 'sent', createdAt: now().toISOString(),
    });
    const overCap = await contributionOverCap(r, created.id);
    if (overCap) {
      await repo.deleteContribution(created.id);
      return fail(res, 409, overCap);
    }
    const borrower = await repo.getUser(r.borrowerId).catch(() => null);
    if (borrower?.email) {
      await safeMail({
        to: borrower.email,
        subject: `${req.user.name} says they sent ${formatInr(parsed.paise)}. Please confirm.`,
        html: `<p>${escapeHtml(req.user.name)} says they sent you ${formatInr(parsed.paise)}.</p>`
          + `<p>Once the money reaches you, please confirm it in the app: ${appLink()}.</p>`,
      });
    }
    res.status(201).json({ contribution: contributionJson(created), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/contributions/:id/confirm', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getContribution, 'Contribution');
    if (!loaded) return;
    const { entry: c, r } = loaded;
    if (r.borrowerId !== req.user.id) return fail(res, 403, 'Only the borrower can confirm that money arrived');
    if (c.status === 'confirmed') {
      await settleFunded(r.id);
      return res.json({ contribution: contributionJson(c), request: await detail(await repo.getRequest(r.id), req.user.id) });
    }
    if (c.status !== 'sent') return fail(res, 409, 'Only an entry marked as sent can be confirmed');
    if (r.status !== 'open') return fail(res, 409, 'This request is no longer open');
    const updated = await repo.updateContribution(c.id, { status: 'confirmed', confirmedAt: now().toISOString(), updatedAt: now().toISOString() });
    // Recompute from fresh rows so two quick confirmations cannot both miss the total.
    await settleFunded(r.id);
    await mailLender(c.contributorId, `${req.user.name} confirmed your ${formatInr(c.amountCents)}`,
      `<p>${escapeHtml(req.user.name)} confirmed they received your ${formatInr(c.amountCents)}. Thank you for helping.</p>`);
    res.json({ contribution: contributionJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/contributions/:id/not-received', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getContribution, 'Contribution');
    if (!loaded) return;
    const { entry: c, r } = loaded;
    if (r.borrowerId !== req.user.id) return fail(res, 403, 'Only the borrower can say money did not arrive');
    if (c.status !== 'sent') return fail(res, 409, 'Only an entry marked as sent can be marked not received');
    const updated = await repo.updateContribution(c.id, { status: 'not_received', updatedAt: now().toISOString() });
    await mailLender(c.contributorId, `${req.user.name} has not received your ${formatInr(c.amountCents)}`,
      `<p>${escapeHtml(req.user.name)} says your ${formatInr(c.amountCents)} has not arrived.</p>`
      + `<p>Please check the amount and UPI reference and correct them in the app, or remove the entry: ${appLink()}.</p>`);
    res.json({ contribution: contributionJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.patch('/contributions/:id', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getContribution, 'Contribution');
    if (!loaded) return;
    const { entry: c, r } = loaded;
    if (c.contributorId !== req.user.id) return fail(res, 403, 'Only the person who sent this can change it');
    if (c.status !== 'not_received') return fail(res, 409, 'You can correct an entry only after the borrower marked it not received');
    const edit = readEntryPatch(req.body, c.amountCents);
    if (edit.error) return fail(res, 400, edit.error, edit.field);
    const { patch, amountCents } = edit;
    const check = rules.checkContribution({
      amountCents, principalCents: r.principalCents, totals: rules.fundingTotals(await repo.listContributions(r.id)),
      contributorId: req.user.id, borrowerId: r.borrowerId,
      isMutual: rules.isMutual(await repo.connections(req.user.id), r.borrowerId), status: r.status,
    });
    if (!check.ok) return fail(res, 409, check.reason);
    const updated = await repo.updateContribution(c.id, patch);
    const overCap = await contributionOverCap(r, c.id);
    if (overCap) {
      await repo.updateContribution(c.id, { status: 'not_received', amountCents: c.amountCents, utr: c.utr ?? null, updatedAt: now().toISOString() });
      return fail(res, 409, overCap);
    }
    res.json({ contribution: contributionJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.delete('/contributions/:id', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getContribution, 'Contribution');
    if (!loaded) return;
    const { entry: c, r } = loaded;
    if (c.contributorId !== req.user.id) return fail(res, 403, 'Only the person who sent this can remove it');
    if (c.status === 'confirmed') return fail(res, 409, 'The borrower already confirmed this, so it cannot be removed');
    await repo.deleteContribution(c.id);
    res.json({ ok: true, request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  // ---- Repayments: the payer marks "sent" to one lender, that lender confirms "received" ----
  const repaymentJson = (p) => ({
    id: p.id, requestId: p.requestId, payerId: p.payerId, lenderId: p.lenderId, amountCents: p.amountCents,
    utr: p.utr ?? null, status: p.status, createdAt: p.createdAt, confirmedAt: p.confirmedAt ?? null,
  });

  // What each lender is still owed. Contributions name their lender as contributorId.
  async function owedFor(requestId) {
    const [contribs, repays] = await Promise.all([repo.listContributions(requestId), repo.listRepayments(requestId)]);
    return rules.owedByLender(contribs.map((c) => ({ ...c, lenderId: c.contributorId })), repays);
  }

  api.post('/requests/:id/repayments', async (req, res) => {
    const r = await visibleRequest(req, res);
    if (!r) return;
    if (req.user.id !== r.borrowerId && req.user.id !== r.trustedContactId) {
      return fail(res, 403, 'Only the borrower or trusted contact can record a repayment');
    }
    if (r.status !== 'funded') return fail(res, 409, 'Repayments can be recorded only for funded requests');
    const rawLender = req.body?.lenderId;
    const lenderId = Number(rawLender);
    if (!(typeof rawLender === 'number' || /^\d+$/.test(rawLender ?? '')) || !Number.isInteger(lenderId)) {
      return fail(res, 400, 'Choose who you are repaying', 'lenderId');
    }
    const parsed = parseRupees(req.body?.amount);
    if (parsed.error) return fail(res, 400, parsed.error, 'amount');
    const u = readUtr(req.body);
    if (u.error) return fail(res, 400, u.error, 'utr');
    const check = rules.checkRepayment({
      amountCents: parsed.paise, payerId: req.user.id, borrowerId: r.borrowerId, trustedContactId: r.trustedContactId,
      lenderId, owed: (await owedFor(r.id)).get(lenderId), status: r.status,
    });
    if (!check.ok) return fail(res, 409, check.reason);
    const created = await repo.addRepayment({
      requestId: r.id, payerId: req.user.id, lenderId, amountCents: parsed.paise, utr: u.utr,
      status: 'sent', createdAt: now().toISOString(),
    });
    const overCap = await repaymentOverCap(r, lenderId, created.id);
    if (overCap) {
      await repo.deleteRepayment(created.id);
      return fail(res, 409, overCap);
    }
    await mailLender(lenderId, `${req.user.name} says they repaid you ${formatInr(parsed.paise)}. Please confirm.`,
      `<p>${escapeHtml(req.user.name)} says they repaid you ${formatInr(parsed.paise)}.</p>`
      + `<p>Once the money reaches you, please confirm it in the app: ${appLink()}.</p>`);
    res.status(201).json({ repayment: repaymentJson(created), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/repayments/:id/confirm', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getRepayment, 'Repayment');
    if (!loaded) return;
    const { entry: p, r } = loaded;
    if (p.lenderId !== req.user.id) return fail(res, 403, 'Only the person who was repaid can confirm it');
    if (p.status === 'confirmed') {
      await settleRepaid(r.id);
      return res.json({ repayment: repaymentJson(p), request: await detail(await repo.getRequest(r.id), req.user.id) });
    }
    if (p.status !== 'sent') return fail(res, 409, 'Only a repayment marked as sent can be confirmed');
    const updated = await repo.updateRepayment(p.id, { status: 'confirmed', confirmedAt: now().toISOString(), updatedAt: now().toISOString() });
    // Recompute from fresh rows so two quick confirmations cannot both miss the total.
    await settleRepaid(r.id);
    const subject = `${req.user.name} confirmed your repayment of ${formatInr(p.amountCents)}`;
    const html = `<p>${escapeHtml(req.user.name)} confirmed they received your repayment of ${formatInr(p.amountCents)}.</p>`;
    for (const uid of new Set([r.borrowerId, p.payerId])) await mailLender(uid, subject, html);
    res.json({ repayment: repaymentJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/repayments/:id/not-received', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getRepayment, 'Repayment');
    if (!loaded) return;
    const { entry: p, r } = loaded;
    if (p.lenderId !== req.user.id) return fail(res, 403, 'Only the person who was repaid can say it did not arrive');
    if (p.status !== 'sent') return fail(res, 409, 'Only a repayment marked as sent can be marked not received');
    const updated = await repo.updateRepayment(p.id, { status: 'not_received', updatedAt: now().toISOString() });
    await mailLender(p.payerId, `${req.user.name} has not received your repayment of ${formatInr(p.amountCents)}`,
      `<p>${escapeHtml(req.user.name)} says your repayment of ${formatInr(p.amountCents)} has not arrived.</p>`
      + `<p>Please check the amount and UPI reference and correct them in the app, or remove the entry: ${appLink()}.</p>`);
    res.json({ repayment: repaymentJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.patch('/repayments/:id', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getRepayment, 'Repayment');
    if (!loaded) return;
    const { entry: p, r } = loaded;
    if (p.payerId !== req.user.id) return fail(res, 403, 'Only the person who sent this can change it');
    if (p.status !== 'not_received') return fail(res, 409, 'You can correct a repayment only after it was marked not received');
    const edit = readEntryPatch(req.body, p.amountCents);
    if (edit.error) return fail(res, 400, edit.error, edit.field);
    const { patch, amountCents } = edit;
    // This entry is not_received, so it is not in the owed figures yet; checking it as new is correct.
    const check = rules.checkRepayment({
      amountCents, payerId: p.payerId, borrowerId: r.borrowerId, trustedContactId: r.trustedContactId,
      lenderId: p.lenderId, owed: (await owedFor(r.id)).get(p.lenderId), status: r.status,
    });
    if (!check.ok) return fail(res, 409, check.reason);
    const updated = await repo.updateRepayment(p.id, patch);
    const overCap = await repaymentOverCap(r, p.lenderId, p.id);
    if (overCap) {
      await repo.updateRepayment(p.id, { status: 'not_received', amountCents: p.amountCents, utr: p.utr ?? null, updatedAt: now().toISOString() });
      return fail(res, 409, overCap);
    }
    res.json({ repayment: repaymentJson(updated), request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.delete('/repayments/:id', async (req, res) => {
    const loaded = await loadEntry(req, res, repo.getRepayment, 'Repayment');
    if (!loaded) return;
    const { entry: p, r } = loaded;
    if (p.payerId !== req.user.id) return fail(res, 403, 'Only the person who sent this can remove it');
    if (p.status === 'confirmed') return fail(res, 409, 'The lender already confirmed this, so it cannot be removed');
    await repo.deleteRepayment(p.id);
    res.json({ ok: true, request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  app.use('/api', api);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode;
    if (status === 413) return res.status(413).json({ error: 'Request is too large' });
    if (status && status >= 400 && status < 500) return res.status(status).json({ error: 'Malformed request' });
    logger.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  // ---- helpers bound to deps ----
  // Email is shown only to its owner. Other members see a name and verifier status.
  function publicUser(u, viewerId) {
    if (!u) return null;
    const out = { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null, isVerifier: !!u.isVerifier };
    if (viewerId !== undefined && u.id === viewerId) {
      out.email = u.email;
      out.upiId = u.upiId ?? null;
      out.isAdmin = !!u.isAdmin;
      out.welcomedAt = u.welcomedAt ?? null;
      out.termsAcceptedAt = u.termsAcceptedAt ?? null;
    }
    return out;
  }

  function summarise(r, asOf, viewerId) {
    const out = {
      id: r.id,
      borrowerId: r.borrowerId,
      trustedContactId: r.trustedContactId,
      category: r.category ?? null,
      purpose: r.purpose,
      principalCents: r.principalCents,
      fundedCents: r.fundedCents ?? null,
      repaymentDate: r.repaymentDate,
      status: rules.effectiveStatus(r, asOf),
      createdAt: r.createdAt,
    };
    // The rejection reason is for the borrower only.
    if (viewerId !== undefined && viewerId === r.borrowerId && r.rejectionReason) out.rejectionReason = r.rejectionReason;
    return out;
  }

  // UPI IDs the viewer may pay: the borrower's (to lenders, and to mutuals while open) and lenders' (to borrower and contact).
  async function payTargets(r, viewerId, contribs, owed) {
    const lenderIds = [...new Set(contribs.map((c) => c.contributorId))].filter((id) => id !== null && id !== undefined);
    const owners = [r.borrowerId, ...owed.keys()].filter((id, i, all) => id !== null && id !== undefined && id !== viewerId && all.indexOf(id) === i);
    if (owners.length === 0) return [];
    const conn = await repo.connections(viewerId);
    const users = await repo.getUsers(owners);
    return owners.map((id) => users.find((u) => u.id === id)).filter((u) => u?.upiId && rules.paymentTargetVisible({
      viewerId, ownerId: u.id, request: r, lenderIds, isMutualWithOwner: rules.isMutual(conn, u.id),
    })).map((u) => ({ userId: u.id, name: u.name, upiId: u.upiId }));
  }

  async function detail(r, viewerId) {
    const asOf = now();
    const [verifs, contribs, repays] = await Promise.all([repo.listVerifications(r.id), repo.listContributions(r.id), repo.listRepayments(r.id)]);
    const totals = rules.fundingTotals(contribs);
    const { confirmedCents: raisedCents, pendingCents } = totals;
    const owed = rules.owedByLender(contribs.map((c) => ({ ...c, lenderId: c.contributorId })), repays);
    const lenders = [...owed].map(([userId, e]) => ({ userId, ...e }));
    const payTo = await payTargets(r, viewerId, contribs, owed);
    const paidCents = repays.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amountCents, 0);
    return {
      ...summarise(r, asOf, viewerId),
      raisedCents,
      pendingCents,
      totals,
      lenders,
      payTo,
      remainingCents: r.status === 'open' ? Math.max(0, r.principalCents - raisedCents - pendingCents) : 0,
      daysOverdue: rules.daysOverdue(r.repaymentDate, asOf),
      paidCents,
      // A rejection note is the borrower's reason: other viewers (bar the verifier who wrote it) do not get the text.
      verifications: verifs.map((v) => ({
        verifierId: v.verifierId, decision: v.decision,
        note: v.decision === 'reject' && viewerId !== r.borrowerId && viewerId !== v.verifierId ? '' : v.note,
      })),
      verificationOutcome: rules.verificationOutcome(verifs, requiredApprovals),
      // The UPI reference is for the lender and the borrower only.
      contributions: contribs.map((c) => {
        const out = contributionJson(c);
        if (viewerId !== c.contributorId && viewerId !== r.borrowerId) out.utr = null;
        return out;
      }),
      // The UPI reference is for the payer and the lender only.
      repayments: repays.map((p) => {
        const out = repaymentJson(p);
        if (viewerId !== p.payerId && viewerId !== p.lenderId) out.utr = null;
        return out;
      }),
    };
  }

  return app;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

module.exports = { createApp };
