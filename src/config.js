'use strict';
// Environment configuration. Reports problems by variable NAME only; never prints or returns a value in a message.

// The production Supabase project reference. Preview deployments must never use it.
const PRODUCTION_SUPABASE_REF = 'enqxchwiqfdqwrvuqlph';

// Preferred name first. The legacy name is accepted so existing deployments keep working.
function resolveSupabaseKey(env) {
  if (env.SUPABASE_SECRET_KEY) return { value: env.SUPABASE_SECRET_KEY, source: 'SUPABASE_SECRET_KEY' };
  if (env.SUPABASE_SERVICE_ROLE_KEY) return { value: env.SUPABASE_SERVICE_ROLE_KEY, source: 'SUPABASE_SERVICE_ROLE_KEY' };
  return { value: null, source: null };
}

function validateServerConfig(env) {
  const problems = [];
  if (!env.SUPABASE_URL) problems.push('SUPABASE_URL is missing');
  else if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(env.SUPABASE_URL)) problems.push('SUPABASE_URL must be an https://<project>.supabase.co address');
  if (!resolveSupabaseKey(env).value) problems.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is missing');
  if (!env.CLERK_PUBLISHABLE_KEY) problems.push('CLERK_PUBLISHABLE_KEY is missing');
  if (!env.CLERK_SECRET_KEY) problems.push('CLERK_SECRET_KEY is missing');
  return problems;
}

// Preview deployments may not reach the production database, whatever the variables say.
function isolationProblems(env) {
  const problems = [];
  // Case-insensitive and anywhere in the address, so no host form slips past.
  const url = (env.SUPABASE_URL || '').toLowerCase();
  if (String(env.VERCEL_ENV || '').toLowerCase() === 'preview' && url.includes(PRODUCTION_SUPABASE_REF)) {
    problems.push('a preview deployment must not use the production database');
  }
  return problems;
}

module.exports = { PRODUCTION_SUPABASE_REF, resolveSupabaseKey, validateServerConfig, isolationProblems };
