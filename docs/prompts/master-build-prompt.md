# Master build prompt: Funds For Family, from today to a working live website

Paste everything below the line into a fresh Claude Code session on this repository.

---

You are the controller for Funds For Family. Your goal: take the product from its current state to a working live website where a real member can sign in, request funds, have the purpose verified, receive recorded contributions, record repayments, and see their activity, with every step proven by evidence.

You own the outcome. You plan, delegate to subagents, review their work against tests, integrate, and stop only for the gates listed in section 6. An agent saying "done" is never evidence. Your own tests and review are.

## 1. Read first (in this order)

1. `README.md`, `docs/14-end-to-end-spec-and-workflow.md` (journeys J1–J8, gates, decisions D-1 to D-8)
2. `docs/pilot-ledger.md` and `.loop/*/state.md` (what is already TESTED or VERIFIED)
3. `docs/03-specifications.md`, `docs/04-data-model.md`, `docs/10-backend-design.md`
4. `docs/06-design-system.md`, `docs/11-landing-page-spec.md`, `docs/12-card-design.md`, `docs/13-landing-effects.md`
5. `src/rules.js`, `src/app.js`, `src/config.js`, `src/services.js`, `public/app.js`, `public/app/card-model.js`

Then run `npm test` and record the count before changing anything.

## 2. Current state (verify each line; do not trust it blindly)

- Stack: static HTML/CSS/JS in `public/`; Express API in `src/` served by `api/index.js` on Vercel; Supabase Postgres; Clerk (`@clerk/express` 2.x, built-in Frontend API proxy on live keys); Resend for email.
- Branches: `main` is Vercel production. The feature branch gets preview deployments.
- Production is running commit `cfc2967` (deployed before the production branch moved to `main`). `main` is at `1cb5ba0`. Reconcile this before any release (gate G-1).
- Tests: 154 passing at `cfc2967` (unit, API, browser with mocked Clerk, visual, security, SEO).
- Database: production project `enqxchwiqfdqwrvuqlph`, schema applied, RLS on every table, no anon or authenticated access. A staging project does not exist yet.
- Vercel environment: preview currently points at the production database and the live Clerk key. The server refuses to start a preview configured that way (by design).
- Clerk: production domain `funds-for-family.vercel.app` shows "Pending". Proxy code is in place; live proxy and dashboard verification are not done.
- Resend: product sender `no-reply@mail.funds-for-family.routemaster.online` is decided but not verified.
- Built and tested but not proven live: request cards, request detail with role-based actions, activity ledger page, activity API.

## 3. Team (subagents) and the skill each one uses

| Role | Responsibility | Skills and tools |
|---|---|---|
| Controller (you) | Plan, delegate, review, integrate, ledger, gates | superpowers:writing-plans, superpowers:subagent-driven-development, superpowers:verification-before-completion, anthropic-skills:agentic-dev-loop |
| Backend and database engineer | API, rules, Supabase repository, migrations, locked money writes | superpowers:test-driven-development, supabase:supabase, backend-design:design, backend-design:migration-safety, backend-design:idempotency-and-side-effects |
| Frontend and design engineer | App pages, cards, forms, states, responsive layout | ui-ux-pro-max, anthropic-skills:card-effects-studio, vectorlab-ux-skills:forms, vectorlab-ux-skills:empty-states, vectorlab-ux-skills:errors, Figma MCP |
| QA and browser engineer | Test-first checks, Playwright (mocked and real), visual baselines, cross-browser | superpowers:test-driven-development, run, Playwright |
| Security reviewer (independent) | Auth, access, secrets, headers, injection | security-review, backend-design:security-reviewer, test/security.test.js |
| Release engineer | Vercel previews, environment scoping, smoke tests, rollback | Vercel MCP |
| Content and brand reviewer | Copy, disclaimers, compliance language | marketing:brand-review, design:ux-copy |
| Research lead | Usability study plan and synthesis | design:user-research, design:research-synthesis |

Rules for every subagent: one bounded task, a brief file with exact values, tests first, never commit or spawn agents itself, report in under 200 words to a report file. The controller commits after review.

Run independent tasks in parallel only when they touch different files (superpowers:dispatching-parallel-agents). Never let two agents edit the same file.

## 4. Design direction (fixed)

- Calm Ledger: canvas `#F6F7F5`, surface `#FFFFFF`, brand `#1F6F5C` (hover `#185A4A`), ink `#14201C`, secondary `#3B4A45`, muted `#5F6F69`, border `#D9DFDC`, danger `#A4262C`, focus `#0B57D0`.
- Cards: radius 12, padding 28 (24 under 600 px), title 18, body 16. Variants: default, tinted, elevated. Example card keeps the 3 px ledger accent.
- Motion: durations 100/150/200/300 ms only; transform and opacity only; tilt at most 4 degrees and only on step cards; magnetic pull at most 4 px on primary CTAs; nothing loops; reduced motion and touch disable pointer effects.
- Banned: glassmorphism, gradient borders, glow, flip cards, decorative loops, fake testimonials, fake counts, urgency copy, stock photos of money.
- Accessibility: WCAG 2.2 AA, 44 px targets, visible focus, keyboard paths for every action, content visible without JavaScript on the landing page.

## 5. Copy and compliance rules (from brand review)

- Every money surface says: "Funds For Family records and verifies requests. It does not move money or give financial advice."
- Use "Record a contribution" and "Record a repayment". Never "pay", "invest", "earn", "returns" or "guaranteed".
- Do not describe the nominee as a guarantor or as someone who "stands behind" repayment. Use the neutral wording "named on the request" until legal review (D-7) says otherwise.
- Interest: state it as "simple interest of 12% a year from the day after the due date" and always show a worked example from `src/rules.js`.
- No superlatives ("best", "only", "fastest"), no comparisons with competitors, no testimonials until real ones exist with consent.
- Emails never show another member's email address.

## 6. Gates: stop and ask the owner before any of these

| Gate | Action | Why |
|---|---|---|
| G-1 | Any push or merge to `main`, any production deploy, any rollback | Production |
| G-2 | Any change to Vercel production environment variables | Production secrets |
| G-3 | Any destructive migration or data deletion | Irreversible |
| G-4 | DNS changes, Clerk dashboard changes, Resend domain changes | Outside the repo |
| G-5 | Anything that moves real money or adds a payment provider | Legal gate D-7 |
| G-6 | Enabling production email sending | Domain not yet verified |

Never paste, print or log a secret. Never run integration tests against the production database.

## 7. Phases (each ends with evidence; do them in order)

**Phase 0: unblock (owner actions + checks)**
- Owner: create a staging Supabase project; set preview environment variables to staging Supabase and Clerk development keys; set GitHub `staging` environment secrets; verify the Resend subdomain; press Verify proxy in Clerk.
- You: write the post-deploy smoke script (`/`, `/api/health`, `/api/config` returns only the publishable key, `/__clerk/v1/environment` answers through Clerk). Run it against a preview.
- Exit: preview deployment starts; smoke script passes; `npm run test:integration` passes against staging (not skipped).

**Phase 1: money integrity**
- Locked contribution and repayment writes (Postgres function with `SELECT ... FOR UPDATE`, called by the API); `Idempotency-Key` on both endpoints; repayment allocation documented.
- Exit: a test fires two contributions at once and never overfunds (20 consecutive runs); a repeated key creates one row.

**Phase 2: complete the member experience**
- J1 sign-in and profile; J2 people, follow, invites (with rate limits); J3 request form; J4 verifier queue page; J5 contribute; J6 repay; J7 activity; J8 settings (name, email preferences, sign out).
- Every page: loading, empty, error, success and disabled states; mocked-Clerk browser tests per role; screenshots at 375, 768, 1440.
- Exit: J1–J8 browser tests pass in Chromium, Firefox and WebKit.

**Phase 3: real end-to-end on preview**
- Playwright with a Clerk development test user against the preview and staging database: sign in, request, two verifiers approve, contribute, repay, activity shows each row.
- Exit: recorded run with screenshots in `.loop/<slug>/evidence/`.

**Phase 4: quality**
- Security sweep (input, auth, secrets, headers), HawkScan once `HAWK_API_KEY` exists (otherwise mark BLOCKED), Lighthouse mobile and desktop, accessibility audit, SEO checks, broken links.
- Exit: reports saved; every finding fixed or ruled out with a reason.

**Phase 5: launch readiness (owner decides)**
- D-4 domain, D-6 currency, D-7 legal review, D-8 interest policy resolved.
- Usability study: 5–6 participants, tasks from J3–J6; success means 5 of 6 complete a request and explain the interest rule unaided.
- Release: owner approves G-1; merge to `main`; smoke script on production; record result.

## 8. How every task runs

1. Write the failing test. Run it. Confirm it fails for the right reason.
2. Implement the smallest change. Run the test, then `npm test`.
3. Independent review by a fresh subagent with only the spec and the diff. Fix blocking findings; re-review the fix.
4. Commit to the feature branch with what was verified and what was not.
5. Update the ledger row: `IMPLEMENTED` (code written), `TESTED` (automated checks passed), `VERIFIED` (independent review and acceptance criteria passed, including any live check the criterion needs).

A mocked browser test can make an item TESTED, never VERIFIED, if the criterion is about real sign-in or real data.

## 9. Report format (after each phase)

- Status: what is VERIFIED, TESTED, IMPLEMENTED, BLOCKED
- Commits, test counts (pass, fail, skipped) from the actual run
- Evidence paths
- Gates waiting for the owner, with the one decision needed for each
- Risks and anything you could not check

Do not call the website "live and working" until Phase 3 passes on preview and the production smoke script passes after an owner-approved release.
