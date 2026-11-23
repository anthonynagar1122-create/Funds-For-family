'use strict';
const express = require('express');
const rules = require('./rules');
const invites = require('./invites');
const { formatInr } = require('../public/app/money');

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

  // Runs only when a NEW member was created by an invite.
  async function acceptInvite(invite, user, email) {
    const asOf = now();
    await repo.updateInvite(invite.id, { acceptedAt: asOf.toISOString(), acceptedUserId: user.id });
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
      let user = await repo.findUserByClerkId(identity.clerkId);
      if (!user) {
        const admission = await admissionFor(req, identity);
        if (!admission) return res.status(403).json(INVITE_ONLY);
        const owner = admission.via === 'owner';
        let created = true;
        try {
          user = await repo.createUser({
            clerkId: identity.clerkId, name: identity.name || 'Member', email: identity.email,
            avatarUrl: identity.avatarUrl ?? null, isAdmin: owner, isVerifier: owner,
          });
        } catch (err) {
          // A concurrent first request may have created the row (unique clerk_id). Use it if it is there.
          user = await repo.findUserByClerkId(identity.clerkId);
          if (!user) throw err;
          created = false;
        }
        if (created && admission.via === 'invite') {
          await acceptInvite(admission.invite, user, String(identity.email ?? '').trim().toLowerCase());
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
  for (const method of ['get', 'post', 'delete']) {
    const original = api[method].bind(api);
    api[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((h) =>
      h.constructor.name === 'AsyncFunction' ? wrapAsync(h) : h));
  }
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use(requireUser);

  api.get('/me', (req, res) => res.json({ user: publicUser(req.user, req.user.id) }));

  // Empty query returns your connections (used for the nominee picker). Two or more characters searches all members.
  api.get('/users', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length === 0) {
      const { following, followers } = await repo.connections(req.user.id);
      const ids = [...new Set([...following, ...followers])];
      const users = await Promise.all(ids.map((id) => repo.getUser(id)));
      return res.json({ users: users.filter(Boolean).map((u) => publicUser(u, req.user.id)) });
    }
    if (q.length < 2) return res.json({ users: [] });
    const users = await repo.searchUsers(q, req.user.id);
    res.json({ users: users.slice(0, 20).map((u) => publicUser(u, req.user.id)) });
  });

  api.get('/users/:id', async (req, res) => {
    const u = await repo.getUser(Number(req.params.id));
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
    await repo.removeFollow(req.user.id, Number(req.params.userId));
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
    const invite = await repo.getInvite(Number(req.params.id));
    if (!invite || invite.inviterId !== req.user.id) return fail(res, 404, 'Invite not found');
    if (invite.acceptedAt) return fail(res, 409, 'This invite has already been used');
    if (!invite.revokedAt) await repo.updateInvite(invite.id, { revokedAt: now().toISOString() });
    res.json({ ok: true });
  });

  api.get('/feed', async (req, res) => {
    const { following, followers } = await repo.connections(req.user.id);
    const ids = [...new Set([...following, ...followers, req.user.id])];
    // Interim filter; Task 9 rewrites the feed.
    const rows = (await repo.listRequestsByBorrowers(ids)).filter((r) => ['open', 'funded', 'repaid'].includes(r.status));
    const withRaised = await Promise.all(rows.map(async (r) => {
      const raisedCents = (await repo.listContributions(r.id)).reduce((sum, c) => sum + c.amountCents, 0);
      return { ...summarise(r, now(), req.user.id), raisedCents };
    }));
    res.json({ requests: withRaised });
  });

  // The member's ledger. Built from requests they borrowed plus requests raised by their connections
  // (the same discovery scope as the feed). Repo has no lookup by participant, so requests outside that scope are not listed.
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
    const out = { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { nominee: [], verifier: [] } };
    for (const { r, verifs, contribs, repays } of details) {
      const myPaid = total(repays.filter((p) => p.payerId === me));
      const myLent = total(contribs.filter((c) => c.contributorId === me));
      if (r.borrowerId === me) out.borrowing.push(row(r, 'borrower', myPaid));
      if (myLent > 0) {
        out.lending.push(row(r, 'lender', myLent));
        if (repays.length > 0) out.repayments.received.push(row(r, 'lender', total(repays)));
      }
      if (myPaid > 0) out.repayments.made.push(row(r, 'payer', myPaid));
      if (r.trustedContactId === me) out.roles.nominee.push(row(r, 'nominee', 0));
      if (verifs.some((v) => v.verifierId === me)) out.roles.verifier.push(row(r, 'verifier', 0));
    }
    res.json(out);
  });

  // Load a request and refuse (404) unless the caller may see it. Returns null after responding.
  async function visibleRequest(req, res) {
    const id = Number(req.params.id);
    const r = Number.isInteger(id) ? await repo.getRequest(id) : null;
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
    const created = await repo.createRequest({
      borrowerId: req.user.id,
      trustedContactId: value.trustedContactId,
      purpose: value.purpose,
      category: value.category,
      principalCents: value.principalCents,
      repaymentDate: value.repaymentDate,
      status: 'awaiting_contact',
      createdAt: now().toISOString(),
    });
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
      const borrower = await repo.getUser(r.borrowerId);
      await safeMail({
        to: borrower.email,
        subject: approved ? 'Your Funds For Family request was approved' : 'Your Funds For Family request was not approved',
        html: approved
          ? `<p>Your request for ${formatInr(r.principalCents)} was <strong>approved and is open for funding</strong>.</p>`
          : `<p>Your request for ${formatInr(r.principalCents)} was <strong>not approved</strong> by the verification team.</p><p>Reason: ${escapeHtml(reason)}</p>`,
      });
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
    res.json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/requests/:id/contributions', async (req, res) => {
    const r = await repo.getRequest(Number(req.params.id));
    if (!r) return fail(res, 404, 'Request not found');
    const amountCents = toCents(req.body?.amount);
    if (amountCents === null) return fail(res, 400, 'Amount must be a positive number with at most 2 decimals', 'amount');
    const totals = rules.fundingTotals((await repo.listContributions(r.id)).map((c) => ({ ...c, status: c.status || 'confirmed' })));
    const raisedCents = totals.confirmedCents;
    const check = rules.checkContribution({ amountCents, principalCents: r.principalCents, totals, contributorId: req.user.id, borrowerId: r.borrowerId, isMutual: true, status: r.status });
    if (!check.ok) return fail(res, 409, check.reason);
    await repo.addContribution({ requestId: r.id, contributorId: req.user.id, amountCents, status: 'confirmed', createdAt: now().toISOString() });
    if (raisedCents + amountCents >= r.principalCents) {
      await repo.updateRequest(r.id, { status: 'funded', fundedAt: now().toISOString() });
    }
    await safeMail({
      to: req.user.email,
      subject: 'Thank you for your contribution',
      html: `<p>You contributed ${formatInr(amountCents)} to request #${r.id}. Thank you.</p>`,
    });
    res.status(201).json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
  });

  api.post('/requests/:id/repayments', async (req, res) => {
    const r = await repo.getRequest(Number(req.params.id));
    if (!r) return fail(res, 404, 'Request not found');
    if (req.user.id !== r.borrowerId && req.user.id !== r.trustedContactId) {
      return fail(res, 403, 'Only the borrower or nominee can record repayments');
    }
    if (r.status !== 'funded') return fail(res, 409, 'Repayments can be recorded only for funded requests');
    const amountCents = toCents(req.body?.amount);
    if (amountCents === null) return fail(res, 400, 'Amount must be a positive number with at most 2 decimals', 'amount');
    await repo.addRepayment({ requestId: r.id, payerId: req.user.id, amountCents, status: 'confirmed', createdAt: now().toISOString() });
    const paid = (await repo.listRepayments(r.id)).reduce((s, p) => s + p.amountCents, 0);
    const due = r.principalCents;
    if (paid >= due) await repo.updateRequest(r.id, { status: 'repaid', repaidAt: now().toISOString() });
    res.status(201).json({ request: await detail(await repo.getRequest(r.id), req.user.id) });
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
    const out = { id: u.id, name: u.name, isVerifier: !!u.isVerifier };
    if (viewerId !== undefined && u.id === viewerId) { out.email = u.email; out.isAdmin = !!u.isAdmin; }
    return out;
  }

  function summarise(r, asOf, viewerId) {
    const out = {
      id: r.id,
      borrowerId: r.borrowerId,
      trustedContactId: r.trustedContactId,
      category: r.category ?? null,
      nomineeId: r.trustedContactId, // alias: the current front end and its tests still read nomineeId
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

  async function detail(r, viewerId) {
    const asOf = now();
    const [verifs, contribs, repays] = await Promise.all([repo.listVerifications(r.id), repo.listContributions(r.id), repo.listRepayments(r.id)]);
    const raisedCents = contribs.reduce((s, c) => s + c.amountCents, 0);
    const paidCents = repays.reduce((s, p) => s + p.amountCents, 0);
    return {
      ...summarise(r, asOf, viewerId),
      raisedCents,
      remainingCents: Math.max(0, r.principalCents - raisedCents),
      daysOverdue: rules.daysOverdue(r.repaymentDate, asOf),
      amountDueCents: r.principalCents,
      paidCents,
      // A rejection note is the borrower's reason: other viewers (bar the verifier who wrote it) do not get the text.
      verifications: verifs.map((v) => ({
        verifierId: v.verifierId, decision: v.decision,
        note: v.decision === 'reject' && viewerId !== r.borrowerId && viewerId !== v.verifierId ? '' : v.note,
      })),
      verificationOutcome: rules.verificationOutcome(verifs, requiredApprovals),
      contributions: contribs.map((c) => ({ contributorId: c.contributorId, amountCents: c.amountCents, createdAt: c.createdAt })),
      repayments: repays.map((p) => ({ payerId: p.payerId, amountCents: p.amountCents, createdAt: p.createdAt })),
    };
  }

  return app;
}

function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return Math.abs(cents - n * 100) < 1e-6 ? cents : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

module.exports = { createApp };
