# 14 — End-to-end specification, feature status and implementation workflow

Status date: 2026-11-21. Baseline commit: `8488bc5` (deployment READY on Vercel).
Companion documents: 01 idea, 03 specifications, 04 data model, 05 integration, 09 Figma, 11 landing spec, 12 cards, 13 landing effects.

## 1. Where we are (measured, not assumed)

| Layer | State | Evidence |
|---|---|---|
| Landing page `/` | Live and tested | 100 automated tests; deployment `8488bc5` READY |
| Database schema | Applied to Supabase project `funds-for-family` | migration `init_funds_for_family` applied; advisors show only the intended "RLS on, no policies" info finding |
| Sign-in (Clerk) | **Not working in production** | `CLERK_PUBLISHABLE_KEY` set; `CLERK_SECRET_KEY` **missing**, so server-side session checks cannot run |
| Data access (Supabase) | **Not working in production** | `SUPABASE_URL` set; `SUPABASE_SERVICE_ROLE_KEY` **missing** |
| Email (Resend) | **Not working in production** | `RESEND_API_KEY` and `EMAIL_FROM` **missing** (email is skipped with a warning) |
| Application features | Implemented in code and tested against an in-memory store; **not verified against the real database** | API tests use `memory-repo`; `supabase-repo` has no integration test yet |
| Live product UI (`/app/`) | Shell only until sign-in works | depends on the three missing secrets |
| Domain | Canonical and sitemap use `funds-for-family.vercel.app`, which another project owns | `APP_URL` points there too |

**Conclusion:** the code path is complete end to end, but the production environment cannot run it. The blocking work is configuration plus one integration test suite, not new features.

## 2. Product ideas backlog (prioritised)

| # | Idea | Why | Priority | Status |
|---|---|---|---|---|
| I-1 | Sign in with Clerk and create a member profile on first visit | Everything depends on identity | P0 | Built; needs secrets |
| I-2 | Request funds: amount, purpose, due date, nominee | Core value | P0 | Built; needs secrets |
| I-3 | Two-person purpose verification before funding | Trust promise | P0 | Built; needs secrets |
| I-4 | Record contributions up to the target, with a clear "record only" label | Core value | P0 | Built; needs secrets |
| I-5 | Record repayments; interest after the due date | Core value | P0 | Built; needs secrets |
| I-6 | Invite by email; follow network; network feed | Circle of trust | P0 | Built; needs secrets |
| I-7 | Activity ledger per member (borrowing, lending, repayments) | Transparency | P1 | Not built (data exists) |
| I-8 | Notifications: decision, funded, repayment due, overdue | Retention and trust | P1 | Partly (decision and contribution receipts); reminders not built |
| I-9 | Member settings: name, email preferences, sign-out | Basic account hygiene | P1 | Not built |
| I-10 | Verifier queue page | Verifiers need a place to act | P1 | Not built (API only) |
| I-11 | Support and dispute workflow | Operational trust | P2 | Not built |
| I-12 | Admin: flags, audit view, verifier management | Operations | P2 | Not built (script only) |
| I-13 | Interactive product previews and scroll storytelling on the landing page | Differentiation | P2 | Effects shipped; previews not built |
| I-14 | Multi-currency and locale formatting | International use | P3 | Not built; currency decision open |
| I-15 | Payments integration | Moves real money | Blocked | Not started; legal gate |

## 3. Personas

- **Borrower** — needs a small amount for a stated purpose; wants a clear repayment plan.
- **Contributor (lender)** — trusts the circle; wants to see purpose, terms and what happened to their money.
- **Verifier** — independent reviewer of purpose; must not be the borrower or nominee.
- **Nominee** — named member who may repay if the borrower cannot. Role wording is subject to the legal gate (see §9).
- **Operator** — manages verifiers, flags, support. Not built.

## 4. End-to-end journeys

### J1 — Join and sign in
1. Visitor lands on `/`, selects "Sign in".
2. Clerk email-code or social sign-in opens; success returns the browser to `/app/`.
3. Server verifies the Clerk session, creates or updates the member profile once (keyed by Clerk subject).
4. Member sees the feed (empty state offers Find people and Invite someone).
- Errors: cancelled sign-in, expired code, rate limit, network failure — each shows a message and a retry.
- Acceptance: a second sign-in with the same account creates no duplicate profile.

### J2 — Build a network
1. Member searches by name (email is never shown to others).
2. Member follows a person; both lists update.
3. Member invites by email. The invite is recorded and emailed with a link.
- Acceptance: followers, following and mutual lists are correct; invitations are rate-limited (to be built).

### J3 — Request funds
1. Borrower opens New request; enters amount (≤ $1,000,000), purpose (20–2000 characters), due date (future), nominee (a member other than the borrower).
2. Server validates and stores the request as `pending_verification`.
3. Borrower sees the request with its verification status.
- Acceptance: invalid input is rejected server-side with a field name; the request never appears in the feed before approval.

### J4 — Verify purpose
1. Two distinct verifiers approve; any rejection closes the request.
2. Verifiers cannot decide on requests where they are borrower or nominee.
3. Each decision is stored once per verifier, with an optional note.
- Acceptance: outcome changes exactly at the threshold; the decision is visible in the request history.

### J5 — Contribute
1. A signed-in member other than the borrower records a contribution up to the remaining amount.
2. When the total reaches the target, the request becomes `funded`.
3. Contributor gets a receipt email (best effort).
- Acceptance: no contribution can exceed the remaining balance; contributions to pending or funded requests are refused. **Known gap:** concurrent contributions can overfund (see §7).

### J6 — Repay and close
1. Borrower or nominee records a repayment on a funded request.
2. Amount due = principal + simple interest from the day after the due date (12% a year, daily, rounded to the cent).
3. When recorded repayments reach amount due, the request becomes `repaid`.
- Acceptance: interest matches the worked example ($1,000.00, 10 days late → $3.29, due $1,003.29).

### J7 — Track activity (not built)
- Ledger tabs: Borrowing, Lending, Repayments made, Repayments received, Requests where I am nominee or verifier.
- Acceptance: each row opens the request and its history; no mixing of recorded commitments with confirmed cash.

### J8 — Manage account (not built)
- Edit name; choose email preferences; sign out; delete account (process to be defined with legal).

## 5. Functional specification by area

| Area | Requirement | Status |
|---|---|---|
| Identity | Clerk session required on every `/api` route except health and config | Built; needs `CLERK_SECRET_KEY` |
| Profiles | One profile per Clerk subject; name and email from Clerk | Built; needs Supabase key |
| Network | Follow, unfollow, followers, following, mutual | Built |
| Search | ≥ 2 characters; returns names, never emails | Built and tested |
| Invites | Unique token; email with link; no registration leak | Built (token and email); rate limit and resend not built |
| Requests | Validation as J3; status machine as J4–J6 | Built and tested (memory store) |
| Verification | Distinct verifiers; separation of roles; one decision each | Built and tested |
| Contributions | Cap at remaining; not to own request; only when open | Built and tested; concurrency gap |
| Repayments | Borrower or nominee only; only when funded; interest rule | Built and tested; allocation to contributors not specified |
| Email | Invites, decisions, contribution receipts | Built; best effort, no outbox |
| Feed | Connections plus own requests; approved statuses only | Built and tested |
| Ledger | Per-member history | Not built |
| Settings | Profile, preferences, sessions | Not built |
| Admin | Flags, audit, verifiers | Not built |

## 6. Non-functional requirements

- **Security:** server-side authorisation on every write; service-role key server-only; no email exposure to other members; CSP and HSTS on the landing page; input ceilings; generic 500 responses.
- **Accessibility:** WCAG 2.2 AA; keyboard operable; visible focus; 44 px targets; reduced motion honoured.
- **Performance:** static landing page; no third-party scripts on the landing page; the signed-in app loads Clerk's scripts only.
- **Reliability:** async errors reach the error handler; a failing dependency returns 500, never a hang.
- **Privacy:** data minimisation; emails visible to their owner only; no tracking on the landing page.
- **Observability (not built):** structured logs with request id; error monitoring; uptime check.

## 7. Known gaps (must close before live use)

| Gap | Risk | Fix |
|---|---|---|
| Concurrent contributions can overfund | Money-state error | Locked Postgres function (`SELECT … FOR UPDATE`) called by the API |
| No idempotency keys on contribution and repayment | Duplicate entries on retry | `Idempotency-Key` header; unique constraint |
| Email is best effort | Lost invitations and notices | Outbox table with retry |
| No rate limits on invites and search | Abuse and enumeration | Limits per member and per IP |
| Supabase repository untested against a real database | Hidden defects in production | Integration suite (§8, T-4) |
| Production secrets missing | Nothing works | §9 decisions and secret setup |

## 8. Testing strategy

| Level | What | Tooling | Count now |
|---|---|---|---|
| T-1 Rules | pure business rules | node:test | 11 |
| T-2 API | every route, auth, validation, errors, privacy | node:test with in-memory store | 40+ |
| T-3 Browser | landing: motion, layout, interaction, CSP, SEO | Playwright (Chromium) | 45+ |
| T-4 Integration | Supabase repository against a real Postgres database | `npm run test:integration`; needs a test project and its service key | 6 written; **not yet run (BLOCKED on the service key)** |
| T-4a Database contract | constraints, status machine, privileges, RLS on real Postgres | Supabase connector probes, run inside a transaction and cleaned up | **13 probes + privilege check: passing** |
| T-5 Cross-browser | Firefox and WebKit | Playwright | **0 — to build** |
| T-6 Visual | landing at 375, 768, 1440 | hashed baselines | 3 |
| T-7 End-to-end | J1–J6 through the real UI with a test Clerk user | Playwright + Clerk test mode | **0 — to build** |
| T-8 Security | category sweep (input, auth, secrets, headers) | node:test | 20 |
| T-9 Live smoke | `/`, `/api/health`, `/api/config`, sign-in redirect after deploy | script run after each deployment | **0 — to build** |

## 9. Decisions and secrets needed (owner: product lead)

| # | Decision or secret | Why it blocks | Who |
|---|---|---|---|
| D-1 | Set `CLERK_SECRET_KEY` in Vercel production | Sign-in and every API call | Owner |
| D-2 | Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel production | Every data read and write | Owner |
| D-3 | Set `RESEND_API_KEY` and `EMAIL_FROM` (verified domain) | Invites and notices | Owner |
| D-4 | Choose the public domain; update `APP_URL`, canonical, sitemap and OG URLs | Links and SEO point at a domain we don't control | Owner |
| D-5 | Clerk production instance (needs an owned domain) | Development keys cannot serve real users | Owner |
| D-6 | Launch currency | Money fields are currently USD | Owner |
| D-7 | Legal review: nominee role and NBFC-P2P classification (research report §5) | Live lending must not start before this | Owner with counsel |
| D-8 | Interest policy confirmation (12%, simple, daily from the day after due) | Financial terms | Owner with counsel |

## 9a. Phase B status (real integration)

| Check | Result | Evidence |
|---|---|---|
| Schema constraints reject invalid data | **Pass** (13 of 13) | Bogus status (insert and update), nominee equal to borrower, purpose under 20 characters, zero principal, self-follow, zero contribution, unknown decision, second decision by the same verifier, duplicate email (case-insensitive), duplicate Clerk id. Valid lifecycle open then funded works |
| Row-level security | **Pass** | RLS enabled on all 7 tables |
| Anonymous and authenticated roles | **Pass** | No select or insert privilege on any table |
| Test data cleaned up | **Pass** | 0 leftover rows |
| Repository methods against Postgres | **Not run** | Needs `SUPABASE_SERVICE_ROLE_KEY` for a test project; suite written and skips with a BLOCKED reason |
| Known edge case | **Open** | A second Clerk account reusing an existing email makes the profile upsert fail (unique email index). Needs a decision: merge, reject, or prompt |

Phase B gate **not yet passed**: the repository suite has to run and pass.

## 10. Implementation workflow

Each phase ends with a gate. A phase is not complete until its gate passes and its commit is pushed. Work is delivered in small commits, each with its tests.

### Phase A — Unblock production (owner action + verification)
- Work: owner sets D-1 to D-3 in Vercel; trigger a deployment.
- Engineering: write T-9 live smoke script; run it.
- **Gate A:** `/api/health` 200; `/api/config` returns the publishable key only; a real sign-in creates one profile; `/api/me` returns the member's own email.

### Phase B — Prove the data layer (T-4)
- Build integration suite against a dedicated test schema in the Supabase project (not production data).
- Cover: profile upsert idempotency; request lifecycle; contribution and repayment writes; search; follows.
- **Gate B:** all J1–J6 API flows pass against Postgres, not only memory.

### Phase C — Close money-integrity gaps (§7)
- Locked contribution function; idempotency keys; repayment allocation rules documented.
- Test-first: write the overfunding race test (two parallel contributions) and watch it fail, then fix.
- **Gate C:** race test passes 20 consecutive runs; duplicate retry creates one row.

### Phase D — Complete the member experience
- Build J7 ledger, J8 settings, I-10 verifier queue, I-8 reminders (scheduled job).
- Each page: E2E test (T-7) for its journey; axe accessibility assertion; screenshots at 375, 768, 1440.
- **Gate D:** J1–J8 pass in Chromium, Firefox and WebKit.

### Phase E — Operations and hardening
- Outbox and retries for email; invite and search rate limits; structured logs; uptime check; HawkScan once `HAWK_API_KEY` is supplied (status now BLOCKED).
- Admin screen (I-12) with audit view.
- **Gate E:** HawkScan run with findings fixed; alert test fires.

### Phase F — Launch readiness
- Gates: D-4 to D-8 resolved; production Clerk instance; accessibility audit (WCAG 2.2 AA); Lighthouse mobile and desktop recorded; cross-browser suite green.
- Rollout: invited pilot group, record-only mode (no lending until D-7 is cleared).

## 11. Definition of done (per feature)

1. Journey and acceptance criteria written in §4 or §5.
2. Failing tests written first; they pass after the change; full suite green.
3. Authorisation checked server-side with a test that a stranger is refused.
4. Accessible: keyboard, focus, labels; checked at 375 px.
5. Deployed to production and checked with the T-9 smoke script.
6. Commit pushed; this document's status table updated.

## 12. Immediate next actions

1. Owner: set D-1, D-2, D-3 in Vercel production; redeploy.
2. Engineering: run the Phase A gate and record the result here.
3. Owner: decide D-4 (domain) and D-6 (currency).
4. Engineering: begin Phase B integration suite once D-2 is set.
