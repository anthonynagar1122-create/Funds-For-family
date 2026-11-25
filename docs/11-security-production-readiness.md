# Funds For Family — Security & Production Readiness

Status: active engineering workstream  
Working branch: `security/production-readiness-2026-11`  
Scope: current Clerk + Express + Supabase Postgres + Vercel application

## Operating principles

1. Clerk is the identity provider. The server must verify the Clerk session on every protected API request.
2. Application roles (admin/verifier) are server-managed database attributes, never trusted from browser input.
3. Supabase service-role credentials remain server-only. Never put them in browser bundles, public runtime config, logs or Git.
4. RLS remains enabled. The current architecture intentionally grants no direct table access to `anon` or `authenticated`; the application accesses data through its server API.
5. Never run schema changes against production until the migration has been reviewed and tested against an isolated preview database.
6. Money is represented as integer paise. Financial mutations must be atomic, idempotent and auditable.
7. A successful redirect, UI toast or client-supplied amount is never proof of a payment. Current v1 records direct transfers; it does not process money.
8. **Interest is disabled in v1.** The product records principal only; no interest, late fee, penalty or compounding calculation may be charged or shown as payable. Revisit only after owner approval and qualified legal/compliance review.

## Verified baseline

- Clerk Express middleware and server-side Clerk user lookup are wired in `src/services.js`.
- Unverified Clerk email addresses are not trusted for admission.
- API routes resolve a server-side member record and enforce admin/verifier/member roles.
- The service-role key is used by `src/supabase-repo.js`, which is server-side only.
- Environment validation rejects a Vercel Preview deployment that points at the production Supabase project reference.
- `vercel.json` includes HSTS, X-Frame-Options, nosniff, Referrer-Policy and a restrictive root-page CSP.
- Existing tests cover anonymous access, role checks, IDOR, input validation, secret patterns and generic error responses.
- The database currently has RLS enabled on seven tables and no direct policies. This is default-deny for API roles when no grants/policies exist; do not add permissive browser policies merely to silence an informational linter warning.
- The isolated staging Supabase project (`sgtfdoiauximmktdhrxb`) has the current application schema (12 tables), with RLS enabled and no direct `anon`/`authenticated` policies. It has migrations `init_funds_for_family`, `customer_ready` and `fix_upi_check` applied. The redundant `0002_align_current_application_schema.sql` draft was removed rather than applied.
- The public landing page already states “No interest”; preserve that statement and ensure app/API calculations remain principal-only.

## 27-control implementation register

| # | Control | Current direction / acceptance evidence |
|---:|---|---|
| 1 | Authentication | Keep Clerk; verify server-side session on every protected route. |
| 2 | Secret storage | Vercel environment variables; server-only keys never returned by `/api/config`. |
| 3 | Database access | RLS enabled; no direct browser table grants; least-privilege server access. |
| 4 | HTTPS | Vercel HTTPS plus HSTS. Validate live response headers. |
| 5 | Password hashing | Clerk owns passwords; do not duplicate password storage in this app. |
| 6 | Server-side validation | Keep pure rules and API validation; add boundary tests for every mutation. |
| 7 | XSS | Escape dynamic HTML; prohibit unsafe user-controlled `innerHTML`; CSP review for all routes. |
| 8 | Monitoring | Add structured request IDs, redacted logs and alerting. |
| 9 | Admin authorization | Verify role on every admin endpoint, not just navigation visibility. |
| 10 | SQL injection | Continue using Supabase query builder / parameterized SQL. |
| 11 | Secret scanning | Gitleaks/TruffleHog in CI; scan current tree and Git history. |
| 12 | Rate limiting | Add distributed limits for sign-in-adjacent API, invites, search and write routes. |
| 13 | CORS | Same-origin API preferred; explicitly allow only known origins if cross-origin use is introduced. |
| 14 | Security headers | Keep HSTS, CSP, frame, MIME and referrer protections; test actual deployment. |
| 15 | Session cookies | Let Clerk manage session cookies; do not weaken Secure/HttpOnly/SameSite defaults. |
| 16 | CSRF | Verify Clerk's request/origin protections for cookie-authenticated mutations; add explicit CSRF defense if custom cookie flows are added. |
| 17 | Reset links | Clerk owns password reset lifecycle and token expiry. |
| 18 | File uploads | No general user file-upload feature in v1. If introduced, use allowlists, size limits, random object names and malware scanning. |
| 19 | Financial integrity | Integer paise, server-derived totals, atomic Postgres transactions and explicit settlement confirmation. |
| 20 | Production debug | Generic client errors; redacted server logs; no secrets or PII in logs. |
| 21 | Dependency updates | Automated audit and reviewed update PRs. |
| 22 | Dependency minimization | Remove only after usage and build/test validation. |
| 23 | Public-file exposure | CI checks for .env, .git, dumps, source maps and backups in deployment output. |
| 24 | Git history scan | Scan all refs/history; treat historical secrets as compromised. |
| 25 | Key rotation | Rotate only confirmed exposed credentials; update Vercel envs and redeploy. |
| 26 | Security review | IDOR, role escalation, XSS, overfunding, over-repayment, anonymous access and cross-member data tests. |
| 27 | Release report | Record commit, migration version, deployment URL, test evidence, open risks and approver. |

## Additional P0 engineering controls

- Atomic contribution reservation: lock the request row and enforce the remaining amount inside one Postgres transaction.
- Atomic repayment reservation: lock the lender/request position and prevent pending + confirmed repayments exceeding that lender's confirmed principal.
- Idempotency: unique request keys for retryable create operations; duplicate retries return the original result.
- Immutable ledger history: append settlement/reversal events; do not silently rewrite confirmed financial facts.
- Verification immutability: preserve the first decision and explicit correction/reversal history rather than silently overwriting a verifier decision.
- Schema contract: migration tests compare application mapper fields with the deployed database.
- Preview isolation: branch-specific Vercel Preview `SUPABASE_URL` points to `funds-for-family-staging` (`sgtfdoiauximmktdhrxb`); the staging secret key still needs to be added directly in Vercel Preview. Never use production database credentials in Preview.
- Recovery: verify backups and perform a documented restore drill before public launch.

## Required integrations

- Existing: GitHub, Vercel, Supabase, Clerk.
- Recommended: Upstash Redis for distributed rate limiting and durable request throttles.
- Optional: Sentry for redacted exception monitoring; evaluate Vercel observability first to avoid duplicate spend.
- Optional: Resend is already wired for email; add delivery/bounce monitoring and an outbox if reliable retry becomes necessary.

## Release gates

A release is not production-ready until:
- application schema contract is reconciled with the isolated staging database;
- integration tests pass against that database;
- contribution/repayment concurrency tests prove no overfunding or over-repayment;
- Clerk sign-in, invite admission, role checks and account lifecycle are tested in a real browser;
- Vercel Preview is READY and manually validated;
- production deployment branch and rollback target are confirmed;
- no unresolved P0 security or ledger issue remains.

## Owner decisions — confirmed

- **Interest policy: review; disabled until approval.** No interest or late-fee calculations are active in v1. The prior 12% annual simple-interest note is an unapproved proposal only and must not be implemented as a financial rule.
- **Navigation: separate Member and Admin/Verifier workspaces.** Member navigation stays focused on personal borrowing/lending and circle activity. Admin/Verifier tools are a distinct workspace and require server-confirmed roles on every route and API action.
- Preview database: staging project identified and schema verified; owner must add its server-side secret key to the branch-specific Vercel Preview environment.
- Rate limiting: Upstash is recommended but not connected or approved for paid usage yet.
- Production deployment: requires explicit approval after Preview acceptance.
