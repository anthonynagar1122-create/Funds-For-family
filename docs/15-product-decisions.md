# 15 — Product decisions (owner, 2026-11-23)

These answers override earlier assumptions in docs 01, 03, 11 and 14 where they differ.

| # | Area | Decision |
|---|---|---|
| P-1 | Product | Record-only ledger. Money moves outside the app. No payment provider. |
| P-2 | Currency | Indian rupee. Stored as integer paise; shown as ₹1,00,000.00 with Indian grouping. |
| P-3 | Nominee | "Trusted contact": a named member who is kept informed and may choose to help or record repayment. No obligation. Never called a guarantor. |
| P-4 | Production | Merge the feature branch into `main` at the next owner-approved release. |
| P-5 | Verifiers | Appointed team, managed by the owner from an admin page. Two approvals open a request; one rejection closes it. |
| P-6 | Interest | None at launch. Track the amount due only. |
| P-7 | Visibility | Mutual connections only (both follow each other), plus the member's own requests. |
| P-8 | Joining | Invite only. Only invited email addresses can create an account. |
| P-9 | Confirming | Two-step: lender records "sent"; borrower confirms "received". Only confirmed amounts count toward funded. |
| P-10 | Repayment | Per lender: borrower records a repayment to a specific lender; the lender confirms receipt. |
| P-11 | Emails | Request decided; contribution to confirm; due date reminders (7 days and 1 day before, to borrower and trusted contact); repayment to confirm. |
| P-12 | Admin | Verifier management; invite controls (see, resend, revoke, limits). |
| P-13 | Home | Overview dashboard: items needing action, then my requests and my contributions. |
| P-14 | Mobile | Responsive web from 320 px. No app-store work. |
| P-15 | Language | English only at launch; text kept in one place for later translation. |
| P-16 | Limits | Up to ₹50,000 per request, repaid within 12 months, one open request per member. |
| P-17 | Staging | Agent creates a separate Supabase staging project (stop if any cost is quoted). |
| P-18 | Landing | Update the copy now to match P-1, P-2, P-3, P-6. |
| P-19 | Build order | Data rules first, then pages. |
| P-20 | Pilot | 5–6 people the owner knows. |

## Staging database (P-17 done, 2026-11-23)

- Project `funds-for-family-staging`, ref `sgtfdoiauximmktdhrxb`, region us-east-1, free tier (no cost quoted).
- `supabase/migrations/0001_init.sql` applied. All 7 public tables have RLS enabled; `anon` and `authenticated` have no privileges (checked with `has_table_privilege`).
- Security advisor: only INFO `rls_enabled_no_policy` on all 7 tables, which is intended (server-only access with the secret key).
- Owner action still needed: put the staging URL and secret key into Vercel **Preview** env and the GitHub Actions staging secrets. Keys are never copied into the repository.

## Owner decisions, 2026-11-27 (production-readiness audit)

| # | Area | Decision |
|---|---|---|
| P-45 | Branches | Combine our branch and `security/production-readiness-2026-11` on a new branch `claude/combined-production`, resolving conflicts by hand per docs/production-readiness/04-branch-reconciliation.md. Nothing reaches `main` or production until the owner approves. |
| P-46 | UTR | Optional when marking money sent (P-22 stands), but unique within a request when given. |
| P-47 | Verifiers | Keep two approvals (P-5). The owner appoints a second verifier before the first request; the borrower sees "Waiting for the verification team" meanwhile. |
| P-48 | Launch scope | Build the daily job that auto-closes requests at their due date and an `EMAIL_ENABLED` switch that defaults off. Reminders stay in-app on Home; the landing page must not promise email reminders. Due-date votes, thank-you notes and receipts come after launch. |
