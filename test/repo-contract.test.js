'use strict';
// The repository contract. Exported so the Supabase integration test runs the same cases against a real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('../src/memory-repo');

let n = 0;
const uniq = () => `c${Date.now().toString(36)}${++n}`;

function runContract(makeRepo, { prefix = '' } = {}) {
  const mk = async (repo, tag) => repo.createUser({ clerkId: `${prefix}${uniq()}_${tag}`, name: `User ${tag}`, email: `${prefix}${uniq()}_${tag}@c.test` });
  const req = (b, c, extra = {}) => ({
    borrowerId: b.id, trustedContactId: c.id, purpose: 'School fees for the second term at college',
    category: 'education', principalCents: 50000, repaymentDate: '2027-03-01', status: 'open', ...extra,
  });

  test('contract: create a user, then find it by clerkId', async () => {
    const repo = await makeRepo();
    const u = await mk(repo, 'a');
    assert.ok(u.id);
    const found = await repo.findUserByClerkId(u.clerkId);
    assert.equal(found.id, u.id);
    assert.equal(found.email, u.email);
    assert.equal(await repo.findUserByClerkId(`${prefix}nobody_${uniq()}`), null);
    const upd = await repo.updateUser(u.id, { name: 'Renamed', upiId: 'ren@okbank' });
    assert.equal(upd.name, 'Renamed');
    assert.equal((await repo.getUser(u.id)).upiId, 'ren@okbank');
    assert.equal((await repo.getUsers([u.id])).length, 1);
  });

  test('contract: findUserByEmail is case-insensitive and treats % and _ literally', async () => {
    const repo = await makeRepo();
    const u = await mk(repo, 'em');
    assert.equal((await repo.findUserByEmail(u.email.toUpperCase())).id, u.id);
    assert.equal(await repo.findUserByEmail(`${prefix}nobody_${uniq()}@c.test`), null);
    assert.equal(await repo.findUserByEmail('%'), null);
    assert.equal(await repo.findUserByEmail(u.email.replace(/^./, '_')), null);
  });

  test('contract: countInvitesSince excludes revoked and superseded invites', async () => {
    const repo = await makeRepo();
    const inviter = await mk(repo, 'inv');
    const since = '2020-01-01T00:00:00.000Z';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString();
    const mkInvite = (tag) => repo.createInvite({ inviterId: inviter.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}${tag}`, expiresAt, createdAt: now });
    const a = await mkInvite('a'); const b = await mkInvite('b'); await mkInvite('c');
    assert.equal(await repo.countInvitesSince(inviter.id, since), 3);
    await repo.updateInvite(a.id, { revokedAt: now });
    assert.equal(await repo.countInvitesSince(inviter.id, since), 2);
    await repo.updateInvite(b.id, { supersededAt: now });
    assert.equal(await repo.countInvitesSince(inviter.id, since), 1);
    assert.equal((await repo.findInviteByHash(a.tokenHash)).id, a.id);
    assert.equal((await repo.listInvitesByInviter(inviter.id)).length, 3);
  });

  test('contract: claimInvite succeeds once, and only while the invite is open and unexpired', async () => {
    const repo = await makeRepo();
    const inviter = await mk(repo, 'ci');
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 14 * 864e5).toISOString();
    const past = new Date(Date.now() - 864e5).toISOString();
    const mkInvite = (tag, expiresAt = future) => repo.createInvite({ inviterId: inviter.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}${tag}`, expiresAt, createdAt: now });
    const a = await mkInvite('a');
    const first = await repo.claimInvite(a.id, { acceptedAt: now });
    assert.equal(first.id, a.id);
    assert.ok(first.acceptedAt);
    assert.equal(await repo.claimInvite(a.id, { acceptedAt: now }), null, 'a second claim loses');
    const u = await mk(repo, 'cu');
    const b = await mkInvite('b');
    assert.equal((await repo.claimInvite(b.id, { acceptedAt: now, acceptedUserId: u.id })).acceptedUserId, u.id);
    const revoked = await mkInvite('r'); await repo.updateInvite(revoked.id, { revokedAt: now });
    assert.equal(await repo.claimInvite(revoked.id, { acceptedAt: now }), null);
    const superseded = await mkInvite('s'); await repo.updateInvite(superseded.id, { supersededAt: now });
    assert.equal(await repo.claimInvite(superseded.id, { acceptedAt: now }), null);
    const expired = await mkInvite('e', past);
    assert.equal(await repo.claimInvite(expired.id, { acceptedAt: now }), null);
    assert.equal((await repo.getInvite(expired.id)).acceptedAt, null);
    assert.equal(await repo.claimInvite(2147483000, { acceptedAt: now }), null, 'unknown invite');
  });

  test('contract: findInviteByAcceptedUser returns the invite this user accepted, or null', async () => {
    const repo = await makeRepo();
    const inviter = await mk(repo, 'fi');
    const u = await mk(repo, 'fu');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString();
    assert.equal(await repo.findInviteByAcceptedUser(u.id), null);
    const inv = await repo.createInvite({ inviterId: inviter.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}fi`, expiresAt, createdAt: now });
    assert.equal(await repo.findInviteByAcceptedUser(u.id), null);
    await repo.updateInvite(inv.id, { acceptedAt: now, acceptedUserId: u.id });
    const found = await repo.findInviteByAcceptedUser(u.id);
    assert.equal(found.id, inv.id);
    assert.equal(found.inviterId, inviter.id);
  });

  test('contract: updateUser can grant admin and verifier', async () => {
    const repo = await makeRepo();
    const u = await mk(repo, 'adm');
    const up = await repo.updateUser(u.id, { isAdmin: true, isVerifier: true });
    assert.equal(up.isAdmin, true);
    assert.equal(up.isVerifier, true);
  });

  test('contract: addContribution returns an id and status sent; updateContribution round-trips', async () => {
    const repo = await makeRepo();
    const [b, c, l] = [await mk(repo, 'b'), await mk(repo, 'c'), await mk(repo, 'l')];
    const r = await repo.createRequest(req(b, c));
    const row = await repo.addContribution({ requestId: r.id, contributorId: l.id, amountCents: 7000, utr: 'ABC123456', status: 'sent', createdAt: new Date().toISOString() });
    assert.ok(row.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.utr, 'ABC123456');
    const up = await repo.updateContribution(row.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
    assert.equal(up.status, 'confirmed');
    assert.equal((await repo.getContribution(row.id)).status, 'confirmed');
    assert.equal((await repo.listContributions(r.id)).length, 1);
    await repo.deleteContribution(row.id);
    assert.equal(await repo.getContribution(row.id), null);
  });

  test('contract: repayments carry payer and lender and round-trip', async () => {
    const repo = await makeRepo();
    const [b, c, l] = [await mk(repo, 'b'), await mk(repo, 'c'), await mk(repo, 'l')];
    const r = await repo.createRequest(req(b, c, { status: 'funded' }));
    const row = await repo.addRepayment({ requestId: r.id, payerId: b.id, lenderId: l.id, amountCents: 1000, status: 'sent', createdAt: new Date().toISOString() });
    assert.equal(row.lenderId, l.id);
    assert.equal((await repo.updateRepayment(row.id, { status: 'not_received' })).status, 'not_received');
    assert.equal((await repo.listRepayments(r.id)).length, 1);
    await repo.deleteRepayment(row.id);
    assert.equal(await repo.getRepayment(row.id), null);
  });

  test('contract: requests expose trustedContactId, category, fundedCents, rejectionReason', async () => {
    const repo = await makeRepo();
    const [b, c] = [await mk(repo, 'b'), await mk(repo, 'c')];
    const r = await repo.createRequest(req(b, c));
    assert.equal(r.trustedContactId, c.id);
    assert.equal(r.category, 'education');
    const up = await repo.updateRequest(r.id, { status: 'rejected', rejectionReason: 'Not enough detail given' });
    assert.equal(up.rejectionReason, 'Not enough detail given');
    assert.ok('fundedCents' in up);
    const again = await repo.updateRequest(r.id, { rejectionReason: 'A clear reason here' });
    assert.equal(again.rejectionReason, 'A clear reason here');
    assert.equal((await repo.getRequest(r.id)).rejectionReason, 'A clear reason here');
    assert.equal((await repo.listRequestsByBorrowers([b.id])).length, 1);
    assert.deepEqual(await repo.listRequestsByBorrowers([]), []);
    assert.equal((await repo.listRequestsByBorrowers([b.id], { statuses: ['open'] })).length, 0);
    assert.equal((await repo.listRequestsByBorrowers([b.id], { statuses: ['rejected', 'open'] })).length, 1);
    assert.deepEqual(await repo.listRequestsByBorrowers([b.id], { statuses: [] }), []);
  });

  test('contract: listRequestsByStatus returns only requests in that status', async () => {
    const repo = await makeRepo();
    const [b, c] = [await mk(repo, 'b'), await mk(repo, 'c')];
    const open = await repo.createRequest(req(b, c, { status: 'open' }));
    await repo.createRequest(req(b, c, { status: 'rejected' }));
    const ids = (await repo.listRequestsByStatus('open')).map((x) => x.id);
    assert.ok(ids.includes(open.id));
    assert.ok((await repo.listRequestsByStatus('open')).every((x) => x.status === 'open'));
  });

  test('contract: countActiveByBorrower counts open but not rejected', async () => {
    const repo = await makeRepo();
    const [b, c] = [await mk(repo, 'b'), await mk(repo, 'c')];
    await repo.createRequest(req(b, c, { status: 'rejected' }));
    assert.equal(await repo.countActiveByBorrower(b.id), 0);
    await repo.createRequest(req(b, c, { status: 'open' }));
    assert.equal(await repo.countActiveByBorrower(b.id), 1);
  });

  test('contract: countActiveAsContact counts awaiting_contact', async () => {
    const repo = await makeRepo();
    const [b, c] = [await mk(repo, 'b'), await mk(repo, 'c')];
    assert.equal(await repo.countActiveAsContact(c.id), 0);
    await repo.createRequest(req(b, c, { status: 'awaiting_contact' }));
    assert.equal(await repo.countActiveAsContact(c.id), 1);
  });

  test('contract: listRequestsForMember includes a request where the member is a repayment lender', async () => {
    const repo = await makeRepo();
    const [b, c, l, other] = [await mk(repo, 'b'), await mk(repo, 'c'), await mk(repo, 'l'), await mk(repo, 'o')];
    const r = await repo.createRequest(req(b, c, { status: 'funded' }));
    assert.equal((await repo.listRequestsForMember(l.id)).length, 0);
    await repo.addRepayment({ requestId: r.id, payerId: b.id, lenderId: l.id, amountCents: 1000, status: 'sent', createdAt: new Date().toISOString() });
    assert.deepEqual((await repo.listRequestsForMember(l.id)).map((x) => x.id), [r.id]);
    assert.deepEqual((await repo.listRequestsForMember(c.id)).map((x) => x.id), [r.id]);
    assert.equal((await repo.listRequestsForMember(other.id)).length, 0);
  });

  test('contract: searchUsers matches name only (not email), excludes the searcher, and treats punctuation literally', async () => {
    const repo = await makeRepo();
    const tag = uniq();
    const me = await repo.createUser({ clerkId: `${prefix}${tag}me`, name: `Zed ${tag}`, email: `${tag}me@c.test` });
    const other = await repo.createUser({ clerkId: `${prefix}${tag}ot`, name: `Zed ${tag} Other`, email: `${tag}ot@c.test` });
    const hits = await repo.searchUsers(`zed ${tag}`, me.id);
    assert.deepEqual(hits.map((u) => u.id), [other.id]);
    assert.deepEqual(await repo.searchUsers(`${tag}ot@c`, me.id), [], 'email is not searchable');
    assert.deepEqual(await repo.searchUsers('a,name.eq.x),or(id.gt.0', me.id), []);
  });

  test('contract: deleteAccount anonymises the member, removes follows and open invites, keeps ledger rows and other people\'s invites', async () => {
    const repo = await makeRepo();
    const [b, c, l, other] = [await mk(repo, 'b'), await mk(repo, 'c'), await mk(repo, 'l'), await mk(repo, 'o')];
    await repo.updateUser(l.id, { upiId: 'l@okbank', avatarUrl: 'https://img.test/l.png' });
    await repo.addFollow(l.id, other.id); await repo.addFollow(other.id, l.id); await repo.addFollow(b.id, other.id);
    const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString();
    const open = await repo.createInvite({ inviterId: l.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}x`, expiresAt });
    const kept = await repo.createInvite({ inviterId: other.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}y`, expiresAt });
    const r = await repo.createRequest(req(b, c, { status: 'repaid' }));
    await repo.addContribution({ requestId: r.id, contributorId: l.id, amountCents: 50000, status: 'confirmed' });
    await repo.addRepayment({ requestId: r.id, payerId: b.id, lenderId: l.id, amountCents: 50000, status: 'confirmed' });
    const joined = await repo.createInvite({ inviterId: other.id, email: l.email, tokenHash: `${prefix}${uniq()}z`, expiresAt });
    await repo.updateInvite(joined.id, { acceptedAt: new Date().toISOString(), acceptedUserId: l.id });

    const out = await repo.deleteAccount(l.id);
    assert.equal(out.id, l.id);
    const gone = await repo.getUser(l.id);
    assert.equal(gone.name, 'Former member');
    assert.ok(gone.deletedAt);
    assert.equal(gone.upiId, null);
    assert.equal(gone.avatarUrl, null);
    assert.equal(gone.clerkId, `deleted:${l.id}`);
    assert.notEqual(gone.email, l.email);
    assert.equal(await repo.findUserByClerkId(l.clerkId), null);
    assert.deepEqual(await repo.connections(l.id), { following: [], followers: [] });
    assert.deepEqual((await repo.connections(other.id)).following, []);
    assert.deepEqual((await repo.connections(b.id)).following, [other.id], 'unrelated follows stay');
    assert.equal(await repo.getInvite(open.id), null);
    assert.ok(await repo.getInvite(kept.id));
    assert.equal((await repo.getInvite(joined.id)).email, `deleted-${l.id}@deleted.invalid`, 'accepted invite no longer holds the real email');
    assert.equal((await repo.getInvite(kept.id)).email.includes('deleted'), false);
    assert.equal((await repo.listContributions(r.id)).length, 1);
    assert.equal((await repo.listRepayments(r.id)).length, 1);
    assert.deepEqual(await repo.searchUsers('Former member', other.id), [], 'deleted members are not searchable');
    assert.equal(await repo.deleteAccount(999999999), null);
  });
  test('contract: help messages are added, listed per user, listed for admin unresolved first, and resolved once', async () => {
    const repo = await makeRepo();
    const a = await mk(repo, 'ha');
    const b = await mk(repo, 'hb');
    const m1 = await repo.addHelpMessage({ userId: a.id, body: 'First help message' });
    const m2 = await repo.addHelpMessage({ userId: b.id, body: 'Second help message' });
    const m3 = await repo.addHelpMessage({ userId: a.id, body: 'Third help message' });
    assert.ok(m1.id && m1.createdAt);
    assert.equal(m1.resolvedAt, null);
    assert.equal(m1.userId, a.id);
    const mine = await repo.listHelpMessagesByUser(a.id);
    assert.deepEqual(mine.map((m) => m.id).sort(), [m1.id, m3.id].sort());
    const at = '2026-11-21T10:00:00.000Z';
    const r = await repo.resolveHelpMessage(m1.id, at);
    assert.equal(new Date(r.resolvedAt).toISOString(), at);
    const again = await repo.resolveHelpMessage(m1.id, '2026-12-01T10:00:00.000Z');
    assert.equal(new Date(again.resolvedAt).toISOString(), at, 'already resolved: kept');
    assert.equal(await repo.resolveHelpMessage(999999999, at), null);
    const all = (await repo.listHelpMessages()).filter((m) => [m1.id, m2.id, m3.id].includes(m.id));
    assert.deepEqual(all.map((m) => m.id), [m2.id, m3.id, m1.id], 'unresolved first (oldest first), then resolved');
  });
  test('contract: admin listings, invite limit, status lists and members who acted', async () => {
    const repo = await makeRepo();
    const a = await mk(repo, 'ad1');
    const b = await mk(repo, 'ad2');
    const c = await mk(repo, 'ad3');
    const gone = await mk(repo, 'ad4');
    await repo.deleteAccount(gone.id);
    const users = await repo.listUsers();
    assert.ok([a, b, c].every((u) => users.some((x) => x.id === u.id)));
    assert.equal(users.some((x) => x.id === gone.id), false, 'deleted members are not listed');
    assert.equal(users.find((x) => x.id === a.id).inviteLimit, null);
    assert.equal((await repo.setInviteLimit(a.id, 7)).inviteLimit, 7);
    assert.equal((await repo.getUser(a.id)).inviteLimit, 7);
    assert.equal((await repo.setInviteLimit(a.id, null)).inviteLimit, null);
    assert.equal(await repo.setInviteLimit(999999999, 3), null);
    const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString();
    const i1 = await repo.createInvite({ inviterId: a.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}p`, expiresAt });
    const i2 = await repo.createInvite({ inviterId: b.id, email: `${uniq()}@x.test`, tokenHash: `${prefix}${uniq()}q`, expiresAt });
    const all = await repo.listInvites();
    assert.ok(all.some((i) => i.id === i1.id) && all.some((i) => i.id === i2.id));
    assert.ok(all.findIndex((i) => i.id === i2.id) < all.findIndex((i) => i.id === i1.id), 'newest first');
    const r = await repo.createRequest(req(b, c));
    const sent = await repo.addContribution({ requestId: r.id, contributorId: a.id, amountCents: 100, status: 'sent' });
    const done = await repo.addContribution({ requestId: r.id, contributorId: a.id, amountCents: 100, status: 'confirmed' });
    const nr = await repo.addContribution({ requestId: r.id, contributorId: a.id, amountCents: 100, status: 'not_received' });
    const ids = (rows) => rows.map((x) => x.id);
    const got = ids(await repo.listContributionsByStatus(['sent', 'not_received']));
    assert.ok(got.includes(sent.id) && got.includes(nr.id) && !got.includes(done.id));
    assert.deepEqual(await repo.listContributionsByStatus([]), []);
    const p1 = await repo.addRepayment({ requestId: r.id, payerId: b.id, lenderId: a.id, amountCents: 100, status: 'sent' });
    const p2 = await repo.addRepayment({ requestId: r.id, payerId: b.id, lenderId: a.id, amountCents: 100, status: 'confirmed' });
    const gotP = ids(await repo.listRepaymentsByStatus(['sent']));
    assert.ok(gotP.includes(p1.id) && !gotP.includes(p2.id));
    const acted = await repo.membersWhoActed([a.id, b.id, c.id]);
    assert.deepEqual([...acted].sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y), 'borrower and contributor, not the trusted contact');
    assert.deepEqual(await repo.membersWhoActed([]), []);
  });
}

module.exports = { runContract };

if (require.main === module) runContract(async () => createMemoryRepo());
