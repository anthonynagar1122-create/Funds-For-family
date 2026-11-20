# 03 — Specifications

Amounts are in **cents** (integers). Dates are `YYYY-MM-DD`. All endpoints return JSON.
Authenticated endpoints use the Clerk session (same-origin cookie).

## Actors
| Actor | Who | Can |
|---|---|---|
| Member | Any signed-in user | Invite, follow, view feed, request funds, contribute, repay if borrower/nominee |
| Verifier | Member with `is_verifier = 1` (set by `scripts/make-verifier.js`) | Approve or reject a request's purpose |
| Borrower | Member who created the request | Records repayments, cannot verify or contribute to own request |
| Nominee | Member named on the request | Records repayments if the borrower does not; cannot verify the request they are nominated on |

## Functional requirements
| ID | Requirement |
|---|---|
| F1 | A user signs in with Clerk (email code or social). Their profile (name, email) is created on first sign-in. |
| F2 | A user can invite a person by email. The invite has a unique token and link, sent through Resend. |
| F3 | A user can search members by name or email, and follow or unfollow them. |
| F4 | A user can list their **followings**, **followers**, and **mutual** connections. |
| F5 | The **feed** shows requests from users the viewer follows **or** who follow the viewer (scaffold assumption), including the viewer's own. Only requests in `open`, `funded` or `repaid` appear in the feed. |
| F6 | A borrower creates a request with: total amount (> 0), purpose (≥ 20 characters), repayment date (after today), and a nominee (existing member, not the borrower). |
| F7 | A new request starts in `pending_verification`. |
| F8 | Verifiers review the purpose and approve or reject, with an optional note. One decision per verifier per request. |
| F9 | Two distinct verifier approvals move the request to `open`. Any rejection moves it to `rejected`. Verifiers cannot be the borrower or nominee. |
| F10 | Any signed-in user, other than the borrower, can contribute a custom amount to an `open` request. Contributions are capped at the remaining amount. |
| F11 | When contributions reach the total, the request becomes `funded` and stops accepting money. |
| F12 | After funding, the borrower or nominee records repayments. Repayments are recorded, not processed. |
| F13 | Amount due = principal + interest. Interest is zero until the repayment date, then accrues daily (simple interest). |
| F14 | When total repayments ≥ amount due, the request becomes `repaid`. |
| F15 | A `funded` request with no full repayment after the repayment date shows as `overdue` (derived). |
| F16 | The request detail shows: status, amounts raised, amount due, days overdue, interest accrued, verifications, and contributions. |

## Non-functional requirements
- **Correctness:** money math is integer-only and unit-tested. Rounding is `Math.round` on cents.
- **Security:** see `docs/02-architecture.md`. No secrets in the repository. `.env` is ignored.
- **Accessibility:** WCAG 2.1 AA targets for colour contrast and keyboard use in the UI.
- **Performance:** feed and detail pages respond in under 300 ms for a community of a few thousand members on SQLite.
- **Auditability:** every verification, contribution and repayment is an append-only row with a timestamp.

## Error format
```json
{ "error": "Human-readable message", "field": "optional_field_name" }
```
Status codes: `400` validation, `401` not signed in, `403` not allowed, `404` not found,
`409` state conflict (for example contributing to a request that is not open).

## Out of scope for this version
Payment processing, SMS, identity verification (KYC), tax reporting, and dispute resolution. Email is in scope (invites and status notices via Resend).
