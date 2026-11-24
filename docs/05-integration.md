# 05 — Integration

| Service | Purpose | Set up by | Environment variables | Status |
|---|---|---|---|---|
| **Supabase** | Postgres database | Create a project, run `supabase/migrations/0001_init.sql` | `SUPABASE_URL`, `SUPABASE_SECRET_KEY (legacy name SUPABASE_SERVICE_ROLE_KEY also accepted)` (server only) | Schema written; project to be created or chosen |
| **Clerk** | Sign-in and sessions | Create an application; enable email sign-in; add the Vercel domain to allowed origins | `CLERK_PUBLISHABLE_KEY` (browser ok), `CLERK_SECRET_KEY` (server only) | Code wired; keys needed |
| **Resend** | Invite and notification emails | Verify a sending domain in Resend; create an API key | `RESEND_API_KEY`, `EMAIL_FROM` | Code wired; sending domain and key needed |
| **Vercel** | Hosting for `public/` and `api/` | Import the GitHub repo; set env vars for Production and Preview | all of the above, plus `APP_URL` | `vercel.json` committed; project to be created |
| **GitHub** | Version control | Push to the feature branch; open a PR when ready | — | Branch `claude/gifted-thompson-e3onnq` |

## Deployment order
1. Create or choose the Supabase project; run the migration (`supabase db push` or paste the SQL in the SQL editor).
2. Create the Clerk application; copy the two keys.
3. Verify the sending domain in Resend; create the API key.
4. Import the GitHub repo into Vercel; set environment variables from `.env.example`.
5. Deploy. Sign in once, then promote a verifier: `node scripts/make-verifier.js you@example.com`.

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_SECRET_KEY (legacy name SUPABASE_SERVICE_ROLE_KEY also accepted)` | — | Server-only data access |
| `CLERK_PUBLISHABLE_KEY` | — | Served to the browser via `/api/config` |
| `CLERK_SECRET_KEY` | — | Server-only session verification |
| `RESEND_API_KEY` | — | Sends email. If missing, email is skipped with a warning. |
| `EMAIL_FROM` | — | Must use a Resend-verified domain |
| `APP_URL` | `http://localhost:3000` | Base for invite links |
| Interest / late-fee settings | Disabled | No interest or late fee is active while the policy is under review; do not add an interest-rate environment variable. |
| `REQUIRED_APPROVALS` | `2` | Distinct verifier approvals to open a request |

Secrets never go in the repository. Add them in the Vercel dashboard or a local `.env` (git-ignored).
