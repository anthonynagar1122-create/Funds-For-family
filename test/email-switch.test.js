'use strict';
// G-08: EMAIL_ENABLED is the master switch for outbound email. Default off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer, emailEnabled } = require('../src/mailer');

const mail = { to: 'someone@example.com', subject: 'Secret subject', html: '<p>hi</p>' };
function harness(env) {
  const sent = []; const logs = [];
  const resend = { emails: { send: async (m) => { sent.push(m); return { error: null }; } } };
  const mailer = createMailer(env, { resend: () => resend, log: (...a) => logs.push(a.join(' ')) });
  return { mailer, sent, logs };
}

test('emailEnabled is false unless EMAIL_ENABLED is exactly true/1/yes/on', () => {
  for (const v of [undefined, '', 'false', '0', 'no', 'off', 'maybe']) assert.equal(emailEnabled({ EMAIL_ENABLED: v }), false, String(v));
  for (const v of ['true', 'TRUE', '1', 'yes', 'on']) assert.equal(emailEnabled({ EMAIL_ENABLED: v }), true, v);
});

test('EMAIL_ENABLED unset: nothing is sent even when RESEND_API_KEY is set, and the log has no address or subject', async () => {
  const h = harness({ RESEND_API_KEY: 're_test' });
  await h.mailer(mail);
  assert.equal(h.sent.length, 0);
  assert.equal(h.logs.length, 1);
  assert.doesNotMatch(h.logs[0], /someone@example\.com|Secret subject|@/);
});

test('EMAIL_ENABLED=false: nothing is sent', async () => {
  const h = harness({ RESEND_API_KEY: 're_test', EMAIL_ENABLED: 'false' });
  await h.mailer(mail);
  assert.equal(h.sent.length, 0);
});

test('EMAIL_ENABLED=true with a key: mail is sent as today', async () => {
  const h = harness({ RESEND_API_KEY: 're_test', EMAIL_ENABLED: 'true', EMAIL_FROM: 'FFF <no-reply@mail.example>' });
  await h.mailer(mail);
  assert.deepEqual(h.sent, [{ from: 'FFF <no-reply@mail.example>', to: mail.to, subject: mail.subject, html: mail.html }]);
});

test('EMAIL_ENABLED=true without a key: skipped with one log line free of addresses', async () => {
  const h = harness({ EMAIL_ENABLED: 'true' });
  await h.mailer(mail);
  assert.equal(h.sent.length, 0);
  assert.equal(h.logs.length, 1);
  assert.doesNotMatch(h.logs[0], /someone@example\.com|Secret subject/);
});

test('a Resend error still surfaces when sending is on', async () => {
  const mailer = createMailer({ RESEND_API_KEY: 'k', EMAIL_ENABLED: 'true' },
    { resend: () => ({ emails: { send: async () => ({ error: { message: 'boom' } }) } }), log: () => {} });
  await assert.rejects(() => mailer(mail), /boom/);
});

test('the Resend client is not even created while the switch is off', async () => {
  let created = 0;
  const mailer = createMailer({ RESEND_API_KEY: 'k' }, { resend: () => { created++; return {}; }, log: () => {} });
  await mailer(mail);
  assert.equal(created, 0);
});
