'use strict';
// Shared steps for tests that need a request to get through the trusted-contact consent step.
const assert = require('node:assert/strict');

const requestBody = (trustedContactId, extra = {}) => ({
  amount: 500,
  purpose: 'School fees for the second term at the local college',
  repaymentDate: '2027-02-01',
  category: 'education',
  trustedContactId,
  ...extra,
});

async function idOf(call, name) {
  return (await call(name, 'GET', '/me')).body.user.id;
}

/** Make two members follow each other (a mutual connection). */
async function connect(call, a, b) {
  await call(a, 'POST', '/follows', { userId: await idOf(call, b) });
  await call(b, 'POST', '/follows', { userId: await idOf(call, a) });
}

/** Borrower names the contact (connecting them first); the contact accepts. Returns the request id, now pending verification. */
async function startRequest(call, borrower, contact, extra = {}) {
  await connect(call, borrower, contact);
  const created = await call(borrower, 'POST', '/requests', requestBody(await idOf(call, contact), extra));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  const accepted = await call(contact, 'POST', `/requests/${id}/contact-decision`, { decision: 'accept' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.request.status, 'pending_verification');
  return id;
}

module.exports = { requestBody, idOf, connect, startRequest };
