# Funds For Family

A community web app where members request small, purpose-checked loans from their trusted circle. A verification team checks the purpose, members record transfers directly, and both sides confirm receipts. Interest is disabled while the policy is under review; the app does not move money.

**Stack:** Vercel (hosting) · Supabase (Postgres) · Clerk (sign-in) · Resend (email) · GitHub (source).

## Documentation
| Doc | Contents |
|---|---|
| [docs/01-idea.md](docs/01-idea.md) | Idea, goals, assumptions |
| [docs/02-architecture.md](docs/02-architecture.md) | System design, stack choices, trade-offs, known limitations |
| [docs/03-specifications.md](docs/03-specifications.md) | Functional and non-functional requirements |
| [docs/04-data-model.md](docs/04-data-model.md) | Database tables and access model |
| [docs/05-integration.md](docs/05-integration.md) | Services, environment variables, deployment order |
| [docs/06-design-system.md](docs/06-design-system.md) | Design tokens and components |
| [docs/07-design-critique.md](docs/07-design-critique.md) | Heuristic design review |
| [docs/08-user-research-plan.md](docs/08-user-research-plan.md) | Research questions and method |
| [docs/09-figma-design-to-code.md](docs/09-figma-design-to-code.md) | Figma status (blocked on a file) |
| [docs/10-backend-design.md](docs/10-backend-design.md) | Endpoint design, failure modes, authorisation map |

## Run locally
Requirements: Node.js 22+.

```bash
npm install
cp .env.example .env      # fill in the Supabase, Clerk and Resend values
npm test                  # unit and API tests (no external services needed)
npm start                 # http://localhost:3000
```

The database schema and subsequent changes are versioned in `supabase/migrations/`. Apply all migrations in order with the Supabase CLI (`supabase db push`) against the intended environment. Do not apply staging-only test data or credentials to production. The security preview branch currently includes atomic financial ledger migrations (0004–0005), audited Admin/Support workflows (0006), and audit actor foreign-key indexes (0007).

## Deploy
See [docs/05-integration.md](docs/05-integration.md#deployment-order). In short: migrate Supabase, set Clerk and Resend keys, import the repo into Vercel, then promote a verifier with `node scripts/make-verifier.js <email>`.

## Project status
Pre-launch. Interest is disabled pending owner and legal/compliance review. Verification threshold (2 approvals) and feed rule (followings and followers) remain product rules to validate. See `docs/01-idea.md`.
