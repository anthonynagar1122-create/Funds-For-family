#!/usr/bin/env node
'use strict';
// Grant or revoke verification-team membership.
// Usage: node scripts/make-verifier.js <email> [--revoke]
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (run locally, never in the browser).
try { require('node:process').loadEnvFile?.('.env'); } catch { /* optional */ }
const { createSupabaseRepo } = require('../src/supabase-repo');

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email.includes('@')) { console.error('Usage: node scripts/make-verifier.js <email> [--revoke]'); process.exit(1); }
  const repo = createSupabaseRepo({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const user = await repo.findUserByEmail(email);
  if (!user) { console.error('No member with that email. They must sign in once first.'); process.exit(2); }
  await repo.setVerifier(user.id, !revoke);
  console.log(`${email} is ${revoke ? 'no longer' : 'now'} a verifier.`);
})().catch((err) => { console.error(err.message); process.exit(1); });
