'use strict';
const express = require('express');
const rules = require('./rules');
const { createRateLimiter } = require('./rate-limit');

/**
 * Build the Express API.
 * deps:
 *   repo        data access (see src/memory-repo.js for the contract; src/supabase-repo.js in production)
 *   identify    async (req) => { clerkId, name, email } | null   (Clerk in production)
 *   mailer      async ({ to, subject, html }) => void            (Resend in production)
 *   now         () => Date
 *   appUrl      string, used in email links
 *   annualRate  number, default rules.DEFAULT_ANNUAL_RATE
 *   requiredApprovals number, default rules.DEFAULT_REQUIRED_APPROVALS
 */
function createApp({ repo, identify, mailer = async () => {}, now = () => new Date(), appUrl = 'http://localhost:3000',
  annualRate = rules.DEFAULT_ANNUAL_RATE, requiredApprovals = rules.DEFAULT_REQUIRED_APPROVALS, logger = console,
  deleteIdentity = async () => {}, rateLimits = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Per-member limits. Invites send email, so they get the tightest bound.
  const limitInvites = createRateLimiter({
    windowMs: 60 * 60 * 1000, max: 20, key: (req) => `invite:${req.user.id}`, ...rateLimits.invites,
  });
  const limitSearch = createRateLimiter({
    windowMs: 60 * 1000, max: 60, key: (req) => `search:${req.user.id}`, ...rateLimits.search,
  });

  const fail = (res, status, error, field) => res.status(status).json(field ? { error, field } : { error });

  const safeMail = async (msg) => {
    try { await mailer(msg); } catch (err) { logger.error('mail failed', err?.message); }
  };

  // Resolve the signed-in user. Creates the local profile on first use.
  async function requireUser(req, res, next) {
    try {
      const identity = await identify(req);
      if (!identity?.clerkId) return fail(res, 401, 'Sign in required');
      req.user = await repo.upsertUser(identity);
      next();
    } catch (err) {
      next(err);
    }
  }

  const api = express.Router();
  const INVITE_TTL_DAYS = 30;

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

  // The member's phone number. Shown only to people who can see one of their requests.
  api.post('/me/phone', async (req, res) => {
    const phone = rules.validatePhone(req.body?.phone);
    if (!phone.ok) return fail(res, 400, phone.error, 'phone');
    const user = await repo.setPhone(req.user.id, phone.value);
    res.json({ user: publicUser(user, req.user.id) });
  });

  // Empty query returns your connections (used for the nominee picker). Two or more characters searches all members.
  api.get('/users', limitSearch, async (req, res) => {
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

  // A member's profile. Their phone is included only if they follow you: they chose you, so you are in the
  // circle that sees their requests (the same rule as rules.canSeeRequest).
  api.get('/users/:id', async (req, res) => {
    const u = await repo.getUser(Number(req.params.id));
    if (!u) return fail(res, 404, 'User not found');
    const user = publicUser(u, req.user.id);
    if (u.id === req.user.id) return res.json({ user, relationship: { youFollow: false, followsYou: false } });
    const { following, followers } = await repo.connections(req.user.id);
    const relationship = { youFollow: following.includes(u.id), followsYou: followers.includes(u.id) };
    if (relationship.followsYou && u.phone) user.phone = u.phone;
    res.json({ user, relationship });
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

  // Create an invite. With an email it is also sent by email; without one it is a link to share (WhatsApp, SMS…).
  api.post('/invites', limitInvites, async (req, res) => {
    const raw = req.body?.email;
    const email = raw === undefined || raw === null || raw === '' ? null : String(raw).trim().toLowerCase();
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email', 'email');
    const token = require('crypto').randomBytes(24).toString('base64url');
    await repo.addInvite({ inviterId: req.user.id, email, token, createdAt: now().toISOString() });
    const link = `${appUrl}/?invite=${token}`;
    if (email) {
      await safeMail({
        to: email,
        subject: `${req.user.name} invited you to Funds For Family`,
        html: `<p>${escapeHtml(req.user.name)} invited you to join Funds For Family.</p><p><a href="${link}">Accept the invitation</a></p>`,
      });
    }
    res.status(201).json({ link });
  });

  // Accept an invite link: the inviter and the new member follow each other, so each is in the other's circle.
  // A link can be shared with several people (for example a family group chat).
  api.post('/invites/accept', async (req, res) => {
    const token = String(req.body?.token ?? '');
    const invite = token.length >= 16 && token.length <= 64 ? await repo.getInviteByToken(token) : null;
    if (!invite) return fail(res, 404, 'This invitation link is not valid');
    if (invite.inviterId === req.user.id) return fail(res, 400, 'This is your own invitation link');
    const created = Date.parse(invite.createdAt);
    if (Number.isFinite(created) && now().getTime() - created > INVITE_TTL_DAYS * 86400000) {
      return fail(res, 410, 'This invitation link has expired. Ask for a new one.');
    }
    const inviter = await repo.getUser(invite.inviterId);
    if (!inviter) return fail(res, 404, 'This invitation link is not valid');
    await repo.addFollow(req.user.id, inviter.id);
    await repo.addFollow(inviter.id, req.user.id);
    await repo.markInviteAccepted(token, now().toISOString());
    res.json({ inviter: publicUser(inviter, req.user.id) });
  });

  // People to connect with: those who follow you, then people your connections know, ranked by mutual connections.
  api.get('/suggestions', async (req, res) => {
    const { following, followers } = await repo.connections(req.user.id);
    const edges = await repo.followsTouching(following.slice(0, 200));
    const picks = rules.suggestConnections({ meId: req.user.id, following, followers, edges });
    const names = new Map();
    const nameOf = async (id) => { if (!names.has(id)) names.set(id, (await repo.getUser(id))?.name ?? 'Member'); return names.get(id); };
    const suggestions = [];
    for (const p of picks) {
      const u = await repo.getUser(p.id);
      if (!u) continue;
      const mutualNames = await Promise.all(p.mutualIds.slice(0, 3).map(nameOf));
      suggestions.push({
        user: publicUser(u, req.user.id),
        mutualCount: p.mutualIds.length,
        mutualNames,
        reason: p.followsYou ? 'Follows you' : `${p.mutualIds.length} mutual connection${p.mutualIds.length === 1 ? '' : 's'}`,
      });
    }
    res.json({ suggestions });
  });

  api.get('/feed', async (req, res) => {
    const { following, followers } = await repo.connections(req.user.id);
    // Borrowers who chose this member (they follow the member), plus the member's own requests.
    const ids = rules.FEED_MODE === 'mutual'
      ? [...following.filter((id) => followers.includes(id)), req.user.id]
      : [...new Set([...followers, req.user.id])];
    const rows = (await repo.listFeed(ids)).filter((r) => rules.isFeedStatus(r.status));
    const withRaised = await Promise.all(rows.map(async (r) => {
      const raisedCents = (await repo.listContributions(r.id)).reduce((sum, c) => sum + c.amountCents, 0);
      return { ...summarise(r, now()), raisedCents, borrower: await borrowerContact(r) };
    }));
    res.json({ requests: withRaised });
  });

  // The verifier's to-do list: pending requests this member may still decide on.
  // Uses the same rule as POST /verify, so the list never offers a request the verify call would refuse.
  api.get('/verification-queue', async (req, res) => {
    if (!req.user.isVerifier) return fail(res, 403, 'Only verification team members can verify');
    const pending = await repo.listPendingRequests({ excludeDecidedBy: req.user.id });
    const open = [];
    for (const r of pending) {
      const allowed = rules.canVerify({ verifier: req.user, requestBorrowerId: r.borrowerId, requestNomineeId: r.nomineeId, requestStatus: r.status });
      if (!allowed.ok) continue;
      const verifs = await repo.listVerifications(r.id);
      if (verifs.some((v) => v.verifierId === req.user.id)) continue;
      open.push({ ...summarise(r, now()), approvals: verifs.filter((v) => v.decision === 'approve').length, requiredApprovals });
    }
    res.json({ requests: open });
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
      if (r.nomineeId === me) out.roles.nominee.push(row(r, 'nominee', 0));
      if (verifs.some((v) => v.verifierId === me)) out.roles.verifier.push(row(r, 'verifier', 0));
    }
    res.json(out);
  });

  // Load a request only if the signed-in member may see it (rules.canSeeRequest). Otherwise answer 404,
  // so members outside the circle cannot even learn that the request exists.
  async function loadVisibleRequest(req, res) {
    const r = await repo.getRequest(Number(req.params.id));
    if (!r) { fail(res, 404, 'Request not found'); return null; }
    const me = req.user.id;
    const [{ followers }, verifs, contribs, repays] = await Promise.all([
      repo.connections(me), repo.listVerifications(r.id), repo.listContributions(r.id), repo.listRepayments(r.id),
    ]);
    const involved = verifs.some((v) => v.verifierId === me) || contribs.some((c) => c.contributorId === me) || repays.some((p) => p.payerId === me);
    if (!rules.canSeeRequest({ viewer: req.user, request: r, viewerFollowers: followers, involved })) {
      fail(res, 404, 'Request not found'); return null;
    }
    return r;
  }

  api.post('/requests', async (req, res) => {
    const { errors, value } = rules.validateRequest(req.body, { borrowerId: req.user.id, now: now() });
    const first = Object.keys(errors)[0];
    if (first) return fail(res, 400, errors[first], first);
    if (!(await repo.getUser(value.nomineeId))) return fail(res, 400, 'Nominee must be an existing member', 'nomineeId');
    // Lenders must be able to reach the borrower. The form can send the number with the request.
    if (req.body?.phone !== undefined && req.body.phone !== '') {
      const phone = rules.validatePhone(req.body.phone);
      if (!phone.ok) return fail(res, 400, phone.error, 'phone');
      req.user = await repo.setPhone(req.user.id, phone.value);
    }
    if (!req.user.phone) return fail(res, 400, 'Add your phone number so lenders can reach you', 'phone');
    const created = await repo.createRequest({
      borrowerId: req.user.id,
      nomineeId: value.nomineeId,
      purpose: value.purpose,
      principalCents: value.principalCents,
      repaymentDate: value.repaymentDate,
      createdAt: now().toISOString(),
    });
    res.status(201).json({ request: summarise(created, now()) });
  });

  api.get('/requests/:id', async (req, res) => {
    const r = await loadVisibleRequest(req, res);
    if (!r) return;
    res.json({ request: await detail(r) });
  });

  api.post('/requests/:id/verify', async (req, res) => {
    const r = await loadVisibleRequest(req, res);
    if (!r) return;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return fail(res, 400, 'decision must be approve or reject', 'decision');
    const check = rules.canVerify({ verifier: req.user, requestBorrowerId: r.borrowerId, requestNomineeId: r.nomineeId, requestStatus: r.status });
    if (!check.ok) return fail(res, 403, check.reason);
    const note = String(req.body?.note ?? '').slice(0, 1000);
    await repo.addVerification({ requestId: r.id, verifierId: req.user.id, decision, note, createdAt: now().toISOString() });
    const outcome = rules.verificationOutcome(await repo.listVerifications(r.id), requiredApprovals);
    if (outcome !== 'pending') {
      const status = outcome === 'approved' ? 'open' : 'rejected';
      await repo.setRequestStatus(r.id, { status, decidedAt: now().toISOString() });
      const borrower = await repo.getUser(r.borrowerId);
      await safeMail({
        to: borrower.email,
        subject: `Your Funds For Family request was ${status === 'open' ? 'approved' : 'rejected'}`,
        html: `<p>Your request for ${formatCents(r.principalCents)} was <strong>${status === 'open' ? 'approved and is open for funding' : 'rejected by the verification team'}</strong>.</p>`,
      });
    }
    res.json({ request: await detail(await repo.getRequest(r.id)) });
  });

  // Records the contribution in one locked step (repo.addContributionAtomic), so the cap holds under concurrency.
  // An optional Idempotency-Key header makes a retry return the original contribution instead of a second one.
  api.post('/requests/:id/contributions', async (req, res) => {
    const r = await loadVisibleRequest(req, res);
    if (!r) return;
    const amountCents = toCents(req.body?.amount);
    if (amountCents === null) return fail(res, 400, 'Amount must be a positive number with at most 2 decimals', 'amount');
    // The lender carries the risk: they confirm they spoke with the borrower first.
    if (req.body?.confirmedContact !== true && r.borrowerId !== req.user.id) {
      return fail(res, 400, 'Call or message the borrower first, then confirm you have spoken', 'confirmedContact');
    }
    const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
    if (idempotencyKey === false) return fail(res, 400, 'Idempotency-Key must be 8 to 100 letters, digits, - or _');

    const result = await repo.addContributionAtomic({
      requestId: r.id, contributorId: req.user.id, amountCents, idempotencyKey, createdAt: now().toISOString(),
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return fail(res, 404, 'Request not found');
      if (result.reason === 'own_request') return fail(res, 409, 'You cannot fund your own request');
      if (result.reason === 'not_open') return fail(res, 409, 'This request is not accepting contributions');
      return fail(res, 409, `Only ${result.remainingCents} cents remain to be funded`);
    }
    if (result.duplicate) return res.json({ request: await detail(await repo.getRequest(r.id)) });

    await safeMail({
      to: req.user.email,
      subject: 'Thank you for your contribution',
      html: `<p>You contributed ${formatCents(amountCents)} to request #${r.id}. Thank you.</p>`,
    });
    res.status(201).json({ request: await detail(await repo.getRequest(r.id)) });
  });

  // Delete my account. Personal data is removed and the sign-in identity is deleted. Requests, contributions and
  // repayments stay, with the member anonymised, so the money trail for other members remains correct.
  // Blocked while the member is borrower or nominee on an open or funded request, because those still have obligations.
  api.delete('/me', async (req, res) => {
    const me = req.user.id;
    const requests = await repo.listRequestsForMember(me);
    const active = requests.some((r) => (r.borrowerId === me || r.nomineeId === me) && (r.status === 'open' || r.status === 'funded'));
    if (active) {
      return fail(res, 409, 'You still have an open or funded request. It must be repaid before you can delete your account.');
    }
    // Identity first: if this fails, nothing is changed and the member can retry.
    await deleteIdentity(req.user.clerkId);
    await repo.anonymizeUser(me);
    res.json({ ok: true });
  });

  api.post('/requests/:id/repayments', async (req, res) => {
    const r = await loadVisibleRequest(req, res);
    if (!r) return;
    if (req.user.id !== r.borrowerId && req.user.id !== r.nomineeId) {
      return fail(res, 403, 'Only the borrower or nominee can record repayments');
    }
    if (r.status !== 'funded') return fail(res, 409, 'Repayments can be recorded only for funded requests');
    const amountCents = toCents(req.body?.amount);
    if (amountCents === null) return fail(res, 400, 'Amount must be a positive number with at most 2 decimals', 'amount');
    await repo.addRepayment({ requestId: r.id, payerId: req.user.id, amountCents, createdAt: now().toISOString() });
    const paid = (await repo.listRepayments(r.id)).reduce((s, p) => s + p.amountCents, 0);
    const due = rules.amountDueCents(r.principalCents, r.repaymentDate, now(), annualRate);
    if (paid >= due) await repo.setRequestStatus(r.id, { status: 'repaid', repaidAt: now().toISOString() });
    res.status(201).json({ request: await detail(await repo.getRequest(r.id)) });
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
    if (viewerId !== undefined && u.id === viewerId) { out.email = u.email; out.phone = u.phone ?? null; }
    return out;
  }

  function summarise(r, asOf) {
    return {
      id: r.id,
      borrowerId: r.borrowerId,
      nomineeId: r.nomineeId,
      purpose: r.purpose,
      principalCents: r.principalCents,
      repaymentDate: r.repaymentDate,
      status: rules.effectiveStatus(r, asOf),
      createdAt: r.createdAt,
    };
  }

  // How a lender reaches the borrower. Only call this for a request the viewer may see (the circle rule):
  // the phone number is shown to the borrower's circle and nobody else.
  async function borrowerContact(r) {
    const b = await repo.getUser(r.borrowerId);
    return b ? { id: b.id, name: b.name, phone: b.phone ?? null } : null;
  }

  async function detail(r) {
    const asOf = now();
    const [verifs, contribs, repays] = await Promise.all([repo.listVerifications(r.id), repo.listContributions(r.id), repo.listRepayments(r.id)]);
    const raisedCents = contribs.reduce((s, c) => s + c.amountCents, 0);
    const paidCents = repays.reduce((s, p) => s + p.amountCents, 0);
    const interest = rules.interestCents(r.principalCents, r.repaymentDate, asOf, annualRate);
    const borrower = await borrowerContact(r);
    return {
      ...summarise(r, asOf),
      raisedCents,
      remainingCents: Math.max(0, r.principalCents - raisedCents),
      daysOverdue: rules.daysOverdue(r.repaymentDate, asOf),
      interestCents: interest,
      amountDueCents: r.principalCents + interest,
      paidCents,
      borrower,
      verifications: verifs.map((v) => ({ verifierId: v.verifierId, decision: v.decision, note: v.note })),
      verificationOutcome: rules.verificationOutcome(verifs, requiredApprovals),
      contributions: contribs.map((c) => ({ contributorId: c.contributorId, amountCents: c.amountCents, createdAt: c.createdAt })),
      repayments: repays.map((p) => ({ payerId: p.payerId, amountCents: p.amountCents, createdAt: p.createdAt })),
    };
  }

  return app;
}

// undefined -> null (no key sent); a valid key -> the key; anything malformed -> false.
function parseIdempotencyKey(raw) {
  if (raw === undefined || raw === '') return null;
  return /^[A-Za-z0-9_-]{8,100}$/.test(raw) ? raw : false;
}

function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return Math.abs(cents - n * 100) < 1e-6 ? cents : null;
}

function formatCents(c) {
  return `$${(c / 100).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

module.exports = { createApp };
