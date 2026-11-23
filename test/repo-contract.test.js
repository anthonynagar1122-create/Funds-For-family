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

  test('contract: searchUsers matches name or email, excludes the searcher, and treats punctuation literally', async () => {
    const repo = await makeRepo();
    const tag = uniq();
    const me = await repo.createUser({ clerkId: `${prefix}${tag}me`, name: `Zed ${tag}`, email: `${tag}me@c.test` });
    const other = await repo.createUser({ clerkId: `${prefix}${tag}ot`, name: `Zed ${tag} Other`, email: `${tag}ot@c.test` });
    const hits = await repo.searchUsers(`zed ${tag}`, me.id);
    assert.deepEqual(hits.map((u) => u.id), [other.id]);
    assert.deepEqual(await repo.searchUsers('a,name.eq.x),or(id.gt.0', me.id), []);
  });
}

module.exports = { runContract };

if (require.main === module) runContract(async () => createMemoryRepo());
