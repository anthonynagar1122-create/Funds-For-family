# 10 — Backend component design

Components reviewed with the backend-design checklist (endpoint, worker, schema).

## Endpoints (HTTP)
| Endpoint | Operation (named by what it does) | Idempotent? | Auth | Notes |
|---|---|---|---|---|
| `POST /api/requests` | Submit a funding request for verification | No (creates) | Signed-in member | Validation → rules → insert |
| `POST /api/requests/:id/verify` | Record a verifier's decision | Yes (one row per verifier, upsert) | Verifier, not borrower/nominee | Status moves to open or rejected when outcome is decided |
| `POST /api/requests/:id/contributions` | Record a contribution | **No: needs fix** | Signed-in, not borrower | Cap check then insert; race condition (see below) |
| `POST /api/requests/:id/repayments` | Record a repayment | No | Borrower or nominee | Repaid when paid ≥ due |
| `POST /api/invites` | Create invite and email it | No | Signed-in | Email is best-effort |

## Failure modes and mitigations
1. **Concurrent contributions overfund a request.** Mitigation: Postgres function with row lock (planned, see `docs/02-architecture.md`).
2. **Email provider down.** Mitigation: best-effort send, logged; outbox table planned.
3. **Clerk or Supabase outage.** Mitigation: fail closed with 500 JSON; no partial writes for single-row operations.
4. **Duplicate submission from a double-click.** Mitigation: the form disables submit while pending (to add in the UI).

## Observability
- Errors are logged via `logger.error` and returned as 500 JSON without stack traces.
- Next: structured logs with request id; Vercel log drains.

## Authorisation map
| Principal | Can read | Can write |
|---|---|---|
| Anonymous | `/api/health`, `/api/config`, static UI | — |
| Member | own profile, feed (network), any request detail | own requests, follows, invites, contributions (not own), repayments (own requests) |
| Verifier | as member | verifications (not own or nominee role) |
