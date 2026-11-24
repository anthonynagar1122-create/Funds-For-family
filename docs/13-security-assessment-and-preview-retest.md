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

- Latest Vercel preview deployment dpl_8KsPdEQzo189pQmiPBzE6KTrbqBm reports READY for commit 6e93f493755a44b6d20ecf8a62c872490947c4b7. URL: https://funds-for-family-7df2g8hwr-anthonynagar1122-7962s-projects.vercel.app.
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
- Vercel Preview: READY for latest branch commit 6e93f493755a44b6d20ecf8a62c872490947c4b7 at https://funds-for-family-7df2g8hwr-anthonynagar1122-7962s-projects.vercel.app.
- GitHub Actions run 45394323912: 394/397 tests passed; the only failures were visual hash checks at 375px, 768px and 1440px. The navigation/role assertions passed. The three baseline files were refreshed to the actual screenshot hashes emitted by that CI run; a follow-up run (45405823601) is in progress.
- GitHub Actions staging integration job in run 45405823601 failed at credential/target preflight. Workflow requires STAGING_SUPABASE_URL and STAGING_SUPABASE_SERVICE_ROLE_KEY in the staging environment; integration tests did not run.
- Preview browser acceptance and Clerk sign-in were not completed because the available browser sandbox could not establish a connection to the Vercel preview.
- Active penetration scan: not run.
- Production change: none.

## Closure requirements

- Add the staging-only Supabase secret to Vercel Preview and the two staging secrets to GitHub Actions; rerun integration tests.
- Confirm follow-up CI run 45405823601 passes after the visual baseline refresh; complete browser/Clerk acceptance.
- Implement and prove financial concurrency/idempotency guarantees.
- Close copy mismatch via a controlled production release.
- Obtain review approval and owner approval before merging/promoting.
