# 05 — Integration and deployment

## Connected services

| Service | Responsibility | Credentials / configuration | Release status |
|---|---|---|---|
| Supabase | PostgreSQL, transactional ledger, audit history | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted) | Staging project exists; migrations 0001–0007 are recorded there |
| Clerk | Authentication and session verification | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Existing application; production sign-in acceptance remains pending |
| Resend | Invites and notifications | `RESEND_API_KEY`, `EMAIL_FROM` | Configure a verified sender before enabling email delivery |
| Vercel | Preview and production hosting | Application variables below | Existing project; deployment of the current security branch is intentionally deferred |
| GitHub Actions | Unit, browser and staging integration checks | GitHub Environment `staging` secrets | Unit/browser and dependency gates run in CI; staging gate awaits secrets |

## Environments and secret boundaries

- Repository: `anthonynagar1122-create/Funds-For-family`.
- Working branch: `security/production-readiness-2026-11`.
- Pull request: [#1](https://github.com/anthonynagar1122-create/Funds-For-family/pull/1), kept as draft until release gates pass.
- Staging Supabase project ref: `sgtfdoiauximmktdhrxb`. Its URL is `https://sgtfdoiauximmktdhrxb.supabase.co`.
- Production project ref: `enqxchwiqfdqwrvuqlph`. Never use production credentials in staging tests.

Set secrets in their target consoles; never commit them or paste them into chat.

### Vercel Preview variables

Set the following for the security branch only, with Preview as the target:

| Variable | Value / rule |
|---|---|
| `SUPABASE_URL` | Staging project URL |
| `SUPABASE_SECRET_KEY` | Staging service-role/secret key; mark Sensitive |
| `CLERK_PUBLISHABLE_KEY` | Existing app's publishable key |
| `CLERK_SECRET_KEY` | Existing server-side secret; mark Sensitive |
| `APP_URL` | The matching Preview origin |

Do not copy the staging URL or key into Production. Do not replace existing production values as part of the Preview setup.

### GitHub Actions staging environment

In repository Settings → Environments → `staging`, configure:

- `STAGING_SUPABASE_URL` = `https://sgtfdoiauximmktdhrxb.supabase.co`
- `STAGING_SUPABASE_SERVICE_ROLE_KEY` = the staging service-role key

The workflow refuses to run if the URL points at production. Values are not printed in logs.

## Database migration procedure

Migrations are versioned in `supabase/migrations/` and must be reviewed and applied in order to the intended project.

Current security branch migration set:

1. `0001_init.sql` — base schema.
2. `0002` and `0003` — customer-ready schema changes and UPI constraint correction (versioned in the Supabase migration history).
3. `0004_atomic_financial_ledger.sql` and `0005_financial_audit_actor_attribution.sql` — atomic create/correction flows, idempotency and append-only financial audit attribution.
4. `0006_admin_audit_and_role_management.sql` — administrator role changes, append-only admin audit, support assignment and resolution RPCs.
5. `0007_index_audit_actor_foreign_keys.sql` — indexes for audit actor and support assignment foreign keys.

Staging migration history also contains an earlier empty/no-op entry named `atomic_financial_ledger`, followed by the implementation migration. Reconcile this history with the checked-in migration files before relying on an automated `supabase db push` from a fresh environment. Do not delete migration history or apply an unreviewed repair to production.

After applying or reconciling migrations in staging, verify:

- Expected tables, columns, indexes, constraints and RPCs exist.
- Financial/admin/support RPCs use `SECURITY INVOKER`; EXECUTE is restricted to `service_role`.
- RLS remains enabled and direct `anon` / `authenticated` access stays revoked; do not add broad public policies to silence informational advisor notices.
- Supabase health advisor is clear and security findings are reviewed.
- Staging remains free of real customer or financial data.

## Deployment and acceptance sequence

Deployments are intentionally deferred until the planned deployment window. Before that window, finish code review and local checks without triggering another Vercel deployment.

1. Confirm the PR head, base-branch divergence and changed-file conflicts. Keep the PR draft until these are resolved.
2. Confirm the staging-only Vercel and GitHub secrets are present (names only; never reveal values).
3. Reconcile migration history, then run the staging-only database integration workflow.
4. Require the unit/API/browser checks, dependency audit and database integration checks to pass.
5. Deploy a fresh Preview for the exact reviewed commit; do not treat the older Preview as evidence for newer commits.
6. Complete Clerk sign-in, member/admin/verifier role access, support assignment, financial create/correct/confirm, keyboard, mobile, 200% zoom and reduced-motion acceptance using synthetic staging users.
7. Review logs, audit trails, error monitoring and security/performance advisors.
8. Obtain explicit owner approval before merging or promoting any build to Production.

No step in this checklist authorizes a production migration, production secret change, PR merge, production deployment or movement of money.

## Runtime environment variables

| Name | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-only database access; legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted |
| `CLERK_PUBLISHABLE_KEY` | Browser sign-in configuration exposed through `/api/config` |
| `CLERK_SECRET_KEY` | Server-side session verification |
| `RESEND_API_KEY` | Email delivery; if absent, email is skipped with a warning |
| `EMAIL_FROM` | Sender on a Resend-verified domain |
| `APP_URL` | Origin used for invite links |
| `PORT` | Local server port (default `3000`) |
| `REQUIRED_APPROVALS` | Distinct verifier approvals (default `2`) |

Interest and late fees remain disabled pending owner and qualified legal/compliance review. The v1 app records direct transfers and confirmations; it does not move money. Trusted contacts are not guarantors and have no repayment obligation.
