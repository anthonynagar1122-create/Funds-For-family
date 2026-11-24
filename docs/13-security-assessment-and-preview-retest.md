# Funds For Family — Security assessment and preview retest record

Assessment date: 2026-11-24  
Repository: anthonynagar1122-create/Funds-For-family  
Branch: security/production-readiness-2026-11  
PR: https://github.com/anthonynagar1122-create/Funds-For-family/pull/1  
Preview deployment: https://funds-for-family-git-sec-cfabe8-anthonynagar1122-7962s-projects.vercel.app  
Staging database: funds-for-family-staging (sgtfdoiauximmktdhrxb)

## Authorization and scope

Owner-authorized defensive review of the named Funds For Family repository, its feature branch, the project's own Vercel preview, and its dedicated Supabase staging project. No active penetration scan or exploit testing was performed. Production DB, production deployment, Clerk infrastructure, Vercel shared infrastructure, end-user devices and unrelated assets were excluded.

## Evidence observed

- Vercel preview deployment dpl_8KsPdEQzo189pQmiPBzE6KTrbqBm reports READY for code commit 6e93f493755a44b6d20ecf8a62c872490947c4b7. URL: https://funds-for-family-7df2g8hwr-anthonynagar1122-7962s-projects.vercel.app. The current branch also has a documentation-only follow-up commit d009d4c7e2c4eb2e7d677a180c57553090ec0338.
- The branch's Vercel Preview environment has a branch-specific staging SUPABASE_URL, Clerk publishable key and APP_URL; it does not have a branch-specific SUPABASE_SECRET_KEY.
- The Vercel project has a production-only Supabase secret key. It was not read or copied. Do not copy this into Preview.
- The branch's runtime configuration explicitly rejects a Preview URL containing the production project ref.
- Staging project is ACTIVE_HEALTHY, has 12 public tables with RLS enabled, zero rows across inspected tables, and three migrations: init_funds_for_family, customer_ready, fix_upi_check.
- Staging security advisor reports INFO-only rls_enabled_no_policy for 12 tables. This is consistent with the current design (server uses service/secret key; anon/authenticated table access is not granted). Do not create broad client policies merely to clear the lint.
- Staging performance advisor reports unused-index INFO notices (expected on an empty staging DB). Health advisor reported no findings.
- Feature branch rules contain no interest-rate constant or interest accumulation function; limits use rupees/paise; trusted contact is not a guarantor.
- Feature branch tests include auth, IDOR, role checks, validation, oversized body, escaping, secret checks, safe error messages, headers, and contribution/repayment permission cases.
- No GitHub PR reviews exist yet. PR #1 remains draft and open; the latest branch commit is 3bcc0250ea3e799e0b1ed2a1aa0fb8b24db368a6.

## Findings

### F-01 — Preview cannot use its staging database yet
Severity: High (release blocker)  
Confidence: Confirmed.

Evidence: branch-specific Vercel Preview variables include staging URL, Clerk publishable key and APP_URL, but no SUPABASE_SECRET_KEY. The application server needs a server-only Supabase secret key. The only configured Supabase secret key is production-targeted; production credentials must not be exposed to Preview.

Impact: preview API is expected to fail configuration checks and authenticated data operations cannot be tested.

Remediation: add the dedicated staging key as a sensitive Preview-only Vercel variable named SUPABASE_SECRET_KEY, scoped to security/production-readiness-2026-11. For GitHub Actions, add STAGING_SUPABASE_URL and STAGING_SUPABASE_SERVICE_ROLE_KEY to the repository's staging environment. These are separate settings. Never paste a secret into chat or commit it. Redeploy the branch and verify /api/health and authenticated /api/me.

### F-02 — Production site still publishes superseded lending terms
Severity: High (customer/legal clarity release blocker)  
Confidence: Confirmed via connected browser view of the production URL.

Evidence: production landing page states 12% annual simple interest, uses USD examples, and says nominee repays if borrower cannot. Feature-branch decision states interest disabled pending review and trusted contact has no repayment obligation.

Impact: visitors may rely on misleading/out-of-date financial terms.

Remediation: merge/release the approved product copy only after Preview acceptance and owner approval. Verify homepage, FAQ, request detail and legal terms use consistent language.

### F-03 — Financial integrity is not yet proven under concurrent writes
Severity: High (release blocker)  
Confidence: Confirmed gap in assessment evidence; not a proven exploit.

Evidence: existing tests cover permission/IDOR paths, but no staging-backed concurrency test was executed. Repository history and docs identify previous read-check-write races. The PR security register calls for atomic contribution reservation, per-lender repayment reservation, idempotency and append-only ledger/audit events.

Impact: simultaneous requests may overfund a request or over-repay a lender if the affected code paths do not serialize writes.

Remediation: implement a single Postgres transaction with row locking/conditional constraints and idempotency keys; add simultaneous-request integration tests; retest using staging.

### F-04 — Admin workspace is partial
Severity: Medium  
Confidence: Confirmed by code review.

Evidence: feature branch has separate role-aware workspace; verifier queue and admin support inbox are implemented. Full member administration, verifier management, immutable audit/operations screens and support assignment are not implemented.

Impact: admin operations still require existing out-of-band/legacy handling.

Remediation: implement these as separate, server-authorized modules before broad team operations depend on them.

### F-05 — Browser-level acceptance has not been completed
Severity: Medium  
Confidence: Confirmed.

Evidence: available connected browser tab is still on the production hostname, not the feature preview. Browser inspection of preview UI and Clerk login is therefore not evidenced.

Impact: no sign-off for responsive layout, navigation, keyboard behavior, Clerk sign-in or end-to-end account lifecycle.

Remediation: open the Preview link, configure its staging secret, authenticate with a dedicated test member, and perform the checklist below.

## Safe browser retest checklist

1. Open Preview root and /app/.
2. Confirm landing copy states no interest, rupee currency, and trusted contact has no guarantor obligation.
3. Confirm signed-out view displays no authenticated navigation.
4. Sign in with a staging-only test identity after the staging key has been added.
5. Complete welcome/terms flow.
6. Confirm Member tabs are Home, Discover, Activity, New, Circle, Profile.
7. For verifier/admin test users, confirm separate Verify/Admin workspace entry; for regular member, direct workspace route must show access denied.
8. Verify admin endpoints return 401 anonymously and 403 to normal members.
9. Verify 320px width, 200% zoom/reflow, visible keyboard focus, keyboard navigation, and reduced-motion mode.
10. Do not create real financial entries or email real users. Use seeded synthetic test accounts only.

## Retest status

- Staging schema/RLS/advisors: inspected; health advisor has no findings.
- Branch configuration isolation: inspected; branch-scoped Preview still has no SUPABASE_SECRET_KEY. The production-only secret was not accessed or copied.
- Vercel Preview: READY for code commit 6e93f493755a44b6d20ecf8a62c872490947c4b7 at https://funds-for-family-7df2g8hwr-anthonynagar1122-7962s-projects.vercel.app. Vercel's build status check is successful.
- GitHub Actions run 45405823601: **397/397 unit, API and browser tests passed**, including visual baselines at 375px, 768px and 1440px and the updated role-aware navigation checks.
- Follow-up run 45406310083 also passed the full **397/397** suite. The added `npm audit --audit-level=high` dependency gate passed.
- The staging integration job in run 45406310083 failed at credential preflight because the staging environment has neither `STAGING_SUPABASE_URL` nor `STAGING_SUPABASE_SERVICE_ROLE_KEY`. Integration tests were not run.
- Preview browser acceptance and Clerk sign-in were not completed because the available browser sandbox could not establish a connection to the Vercel preview.
- Active penetration scan: not run.
- Production change: none.

## Closure requirements

- Add the staging-only Supabase secret to Vercel Preview and add STAGING_SUPABASE_URL plus STAGING_SUPABASE_SERVICE_ROLE_KEY to the GitHub Actions staging environment; rerun integration tests.
- Complete live browser/Clerk acceptance against Preview.
- Implement and prove financial concurrency/idempotency guarantees.
- Close copy mismatch via a controlled production release.
- Obtain review approval and owner approval before merging/promoting.


## Financial integrity retest — 2026-11-24

- Implemented `0004_atomic_financial_ledger.sql` on the isolated staging project. It adds a server-only idempotency ledger, append-only financial audit events, Postgres row-locking RPCs for new contributions/repayments and their correction flows, and explicit `service_role` EXECUTE grants. Functions are `SECURITY INVOKER`; anon/authenticated cannot execute them.
- API creation routes now call the transactional RPCs instead of read/check/insert sequences. Browser forms send a stable `Idempotency-Key` and retain it on retryable server failures. Memory repository behavior mirrors the same caps/replay contract.
- Added concurrency/idempotency tests for the repository contract and a staging integration test. The focused local API/final-fix/financial suite passed 68/68. `git diff --check` passed. The full local suite could not be completed in this Upstash box because its Chromium runtime lacks system `libglib-2.0.so.0`; CI browser suite is still the authoritative browser result.
- Ran a staging SQL smoke test in a transaction with synthetic users, mutual follows, an open request, contribution replay, repayment creation, audit-trigger checks and append-only mutation rejection. The test transaction rolled back; staging remains empty. Database metadata confirms all four RPCs are `SECURITY INVOKER`, executable by `service_role`, and not executable by `authenticated`.
- Staging security advisor now reports 14 INFO-only `rls_enabled_no_policy` notices (the 12 existing server-only tables plus the two new private tables); health advisor remains clear. No broad policies were added.
- Migration history includes a no-op `atomic_financial_ledger` entry created during an earlier migration invocation, followed by the actual `atomic_financial_ledger_implementation` migration. The latter is the migration containing the SQL above. This extra empty history entry does not change schema state, but should be reconciled in the repository's migration bookkeeping before future migration automation.
- F-03 is partially remediated but remains open until the staging GitHub Actions integration job runs against the new RPCs and the concurrent request test passes against Postgres. The staging GitHub secrets are still not configured. No production DB or deployment was changed.


## Admin workspace implementation — 2026-11-24

- Added restricted admin API endpoints for member listing/search, role updates, operations metrics and recent admin audit events. Each endpoint requires the server-resolved administrator role.
- Added a transactional admin_set_member_roles RPC (SECURITY INVOKER, service-role EXECUTE only). It serializes concurrent role changes, prevents removal of the final administrator, and records before/after role states in admin_audit_events.
- The admin audit table is RLS-enabled, unavailable to anon/authenticated, and protected against row UPDATE/DELETE. No member-management operation writes role flags directly from a client.
- The admin workspace now displays member and role controls, operational counts, and recent administrative audit events. Existing verifier queue and support inbox remain.
- Focused local API, repository, and financial tests passed 62/62 before adding the migration assertion; rerun after all changes. npm audit --audit-level=high reported zero vulnerabilities.
- Staging database connectivity timed out while applying migration 0006; application is not confirmed. Do not assume the admin endpoints are ready on a deployed preview until this migration is verified on staging and the new Preview is deployed.
- Support assignment is still not implemented. It needs an explicit assignee model and audit/state contract before shipping; current support messages can be listed and resolved only.


## Support assignment implementation — 2026-11-24

- Added administrator-only support assignment and unassignment. Eligible assignees must be active administrators or verifiers.
- Assignment changes and resolution are performed by Postgres RPCs with row locks and an append-only support_audit_events history. Functions use SECURITY INVOKER; EXECUTE is restricted to service_role.
- Admin inbox displays assignee, assignment control, and resolve action. The unified admin audit endpoint includes role and support events.
- API tests cover member denial, invalid/inactive assignees, assign/reassign/unassign, audit history, and idempotent resolution.
- Focused API/repository/financial/migration tests: 65/65 passed before the final unified-audit assertion; rerun full suite after it.
- Staging migration application remains unverified due database connectivity failure. The branch migration must be applied and checked in isolated staging before Preview acceptance.
