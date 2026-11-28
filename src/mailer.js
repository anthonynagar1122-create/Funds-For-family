'use strict';
// Outbound email. EMAIL_ENABLED is the master switch (P-48, owner-only rule): off by default, and while it is
// off no email leaves the app by any path, whatever RESEND_API_KEY says.

const ON = new Set(['true', '1', 'yes', 'on']);
const emailEnabled = (env) => ON.has(String(env.EMAIL_ENABLED || '').trim().toLowerCase());

/**
 * @param env   environment (reads EMAIL_ENABLED, RESEND_API_KEY, EMAIL_FROM)
 * @param deps  { resend: () => client, log }  injectable for tests; `resend` is only called when sending is on
 * Log lines never contain an address or subject.
 */
function createMailer(env, { resend, log = console.warn } = {}) {
  const enabled = emailEnabled(env);
  const from = env.EMAIL_FROM || 'Funds For Family <no-reply@example.invalid>';
  let client = null;
  return async ({ to, subject, html }) => {
    if (!enabled) { log('email skipped: EMAIL_ENABLED is off'); return; }
    if (!env.RESEND_API_KEY) { log('email skipped: RESEND_API_KEY is not set'); return; }
    client = client || resend();
    const { error } = await client.emails.send({ from, to, subject, html });
    if (error) throw new Error(error.message);
  };
}

module.exports = { createMailer, emailEnabled };
