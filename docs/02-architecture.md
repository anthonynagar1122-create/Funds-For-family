# 02 — Architecture

## System design (summary)
Funds For Family is a small, trust-centred web app. Requirements that shape the design:
- Members see requests only from their network (followings and followers).
- Money is recorded, not moved (no payment processing in v1).
- Every decision (verification, contribution, repayment) must be auditable and computed the same way for everyone.
- Launch with a small community: low ops load, cheap, managed services.

## Chosen stack
| Concern | Service | Why |
|---|---|---|
| Frontend hosting | **Vercel** (static `public/` + serverless `api/index.js`) | Zero-config deploys from GitHub, preview URLs per branch |
| API | Express app (`src/app.js`) running as one Vercel function | Same code runs locally with `npm start` and in tests |
| Database | **Supabase Postgres** (`supabase/migrations/`) | Managed Postgres, migrations in git, RLS as defence in depth |
| Authentication | **Clerk** (`@clerk/express` on the server, `clerk-js` in the browser) | Hosted sign-in, sessions, email verification; no password storage for us |
| Email | **Resend** (`resend` SDK, sent from `src/services.js`) | Invites and request-status notices; domain verification in Resend |
| Version control | **GitHub** (`anthonynagar1122-create/Funds-For-family`) | Pull requests, Vercel Git integration |

## Diagram
```
 Browser ── clerk-js (sign-in) ──▶ Clerk
   │
   │ same-origin /api/* (Clerk session cookie)
   ▼
 Vercel function: api/index.js ── Express (src/app.js)
   │  clerkMiddleware → identify user → upsert profile
   │  business rules (src/rules.js)  ← pure, unit-tested
   │
   ├──▶ Supabase Postgres (service role, server-only; RLS on, no anon/authenticated access)
   └──▶ Resend API (invites, status emails)
```

## Request lifecycle
```
            2 distinct approvals             total contributed
pending_verification ───────────▶ open ─────────────────────────▶ funded ──repaid in full──▶ repaid
        │                          │                                 │
        │ any rejection            │                                 │ past repayment date, unpaid
        ▼                          ▼                                 ▼
     rejected                 (accepts money)                 overdue (derived; interest accrues daily)
```

## Key decisions and trade-offs
1. **Server-side writes, not browser writes to Supabase.** The business rules (caps, verifier separation, status transitions) run in one place. Trade-off: the API is a single point to scale. Acceptable at community scale.
2. **RLS on, zero policies for `anon`/`authenticated`.** The browser never talks to Supabase directly. If we later need direct reads, we add narrow policies, never broad ones.
3. **Clerk for identity, our own `users` table for the domain.** Clerk's `sub` is stored as `users.clerk_id`. We never store passwords or use `user_metadata` for authorisation.
4. **Money in integer cents.** Enforced by `integer` columns and `Math.round` in `src/rules.js`.
5. **Interest is computed, not stored.** Amount due is derived from principal, due date, and the rate. Stored history is only what happened (contributions, repayments, decisions).

## Known limitations (to fix before real money)
- **Race conditions on contributions and repayments.** Two concurrent requests can each pass the cap check. Fix: move the check and insert into a Postgres function that locks the request row (`SELECT … FOR UPDATE`), called via RPC with EXECUTE granted only to `service_role`.
- **Email is best-effort.** A failed send is logged and does not roll back the action. Fix: an outbox table and a retry job.
- **No rate limiting** on invites or search. Add Vercel Firewall rules or an upstream limiter.
- **Interest rate is an assumption** (12%/yr). It must be confirmed by a qualified adviser for the jurisdiction.

## Folder layout
```
api/index.js                 Vercel function entry (all /api/* routes)
src/app.js                   Express routes and request handling
src/services.js              production wiring: Clerk, Resend, Supabase
src/supabase-repo.js         Supabase data access (service role)
src/memory-repo.js           in-memory data access for tests
src/rules.js                 pure business rules
src/server.js                local entry point (npm start)
public/                      web UI (index.html, app.js, styles.css)
supabase/migrations/         SQL migrations applied to the Supabase project
scripts/make-verifier.js     grant verification-team membership (server-side)
test/                        node:test suites (rules + API)
docs/                        this documentation
```

## Security posture
- Secrets only in environment variables (Vercel project settings, or `.env` locally, which is git-ignored).
- The service role key is never shipped to the browser; the publishable Clerk key is the only key in the page.
- Authorisation checks: verifier membership, borrower/nominee separation, only nominee/borrower may record repayments, borrower cannot fund their own request.
- Security headers set in `vercel.json`. Input validated for every write.
