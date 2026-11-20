# 04 — Data model

Postgres schema, defined in `supabase/migrations/0001_init.sql`. Row Level Security is enabled on every table.

```
users ──< follows >── users          (follower_id → followee_id)
users ──< invites                    (inviter_id)
users ──< requests                   (borrower_id, nominee_id)
requests ──< verifications           (one decision per verifier)
requests ──< contributions
requests ──< repayments
```

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `clerk_id` (unique), `name`, `email` (unique, case-insensitive index), `is_verifier` | Profile created on first sign-in. `is_verifier` set only via `scripts/make-verifier.js`. |
| `follows` | `follower_id`, `followee_id` (PK pair) | CHECK forbids self-follow. |
| `invites` | `inviter_id`, `email`, `token` (unique), `accepted_at` | Token is emailed through Resend. |
| `requests` | `borrower_id`, `nominee_id`, `purpose` (≥ 20 chars), `principal_cents`, `repayment_date`, `status`, `decided_at`, `funded_at`, `repaid_at` | `status` CHECK: `pending_verification`, `rejected`, `open`, `funded`, `repaid`. Nominee ≠ borrower. |
| `verifications` | `request_id`, `verifier_id` (PK pair), `decision`, `note` | One decision per verifier per request. |
| `contributions` | `request_id`, `contributor_id`, `amount_cents` | Append-only. |
| `repayments` | `request_id`, `payer_id`, `amount_cents` | Append-only. |

Amounts are `integer` cents. Derived values (not stored): `overdue`, `interest`, `amount_due`, `raised`, `days_overdue`.

## Access
- RLS enabled on all tables; `anon` and `authenticated` have no privileges.
- The server connects with the service role key, which bypasses RLS. This key lives only in server environment variables.
