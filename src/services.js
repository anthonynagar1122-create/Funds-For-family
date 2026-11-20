'use strict';
// Production wiring: Clerk (identity), Resend (email), Supabase (data). Used by server.js and api/index.js.
const express = require('express');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');
const { Resend } = require('resend');
const { createApp } = require('./app');
const { createSupabaseRepo } = require('./supabase-repo');
const config = require('./config');

function buildProductionApp(env = process.env) {
  // Every entry point (server.js and api/index.js) passes through here, so the same checks always run.
  const problems = [...config.validateServerConfig(env), ...config.isolationProblems(env)];
  if (problems.length) throw new Error(`Configuration incomplete: ${problems.join('; ')}`);
  const repo = createSupabaseRepo({ url: env.SUPABASE_URL, serviceRoleKey: config.resolveSupabaseKey(env).value });

  const identify = async (req) => {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const u = await clerkClient.users.getUser(userId);
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Member';
    const email = u.primaryEmailAddress?.emailAddress;
    if (!email) return null;
    return { clerkId: u.id, name, email };
  };

  const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  const from = env.EMAIL_FROM || 'Funds For Family <no-reply@example.invalid>';
  const mailer = async ({ to, subject, html }) => {
    if (!resend) { console.warn('RESEND_API_KEY not set; email skipped:', subject); return; }
    const { error } = await resend.emails.send({ from, to, subject, html });
    if (error) throw new Error(error.message);
  };

  const api = createApp({
    repo,
    identify,
    mailer,
    appUrl: env.APP_URL || 'http://localhost:3000',
    annualRate: env.INTEREST_RATE_ANNUAL ? Number(env.INTEREST_RATE_ANNUAL) : undefined,
    requiredApprovals: env.REQUIRED_APPROVALS ? Number(env.REQUIRED_APPROVALS) : undefined,
  });

  const root = express();
  root.disable('x-powered-by');
  root.use(clerkMiddleware());
  root.get('/api/config', (_req, res) => res.json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || null }));
  root.use(api);
  root.use(express.static(require('path').join(__dirname, '..', 'public')));
  return root;
}

module.exports = { buildProductionApp };
