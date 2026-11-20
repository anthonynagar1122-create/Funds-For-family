# 07 — Design critique (heuristic, from code)

Scope: the current `public/` UI as written. This was **not** done on rendered screens. Re-run the critique once screenshots exist.

## What works
- Single clear primary action per view ("Submit for verification", "Contribute", "Approve purpose").
- Money is always shown in dollars with cents; states use text badges as well as colour.
- Forms show field-level errors linked to inputs, with focus moved to the first error.

## Findings
| # | Finding | Severity | Recommendation |
|---|---|---|---|
| 1 | Feed cards show the requested amount but not funding progress, so members cannot tell which requests need help. | 🟡 Moderate | Show a progress bar and "$X remaining" on feed cards, not only on detail. |
| 2 | The "Approve" / "Reject" buttons look equally weighted in a single row beside an optional note. | 🟡 Moderate | Keep Approve as primary; move Reject to a secondary, labelled "Reject with reason" that makes the note required. |
| 3 | "Interest starts after the repayment date" appears only on the form hint. Borrowers and nominees may miss it. | 🔴 Critical | Show the interest rule and a worked example on the request detail and before submission. |
| 4 | Nominee picker lists only connections. A new member cannot be named until they are connected. | 🟡 Moderate | Allow searching all members, or an invite-and-name flow, with a clear explanation. |
| 5 | Empty feed message is good but gives no next step beyond "follow people". | 🟢 Minor | Add a button to "Invite someone" from the empty state. |
| 6 | Mobile layout not yet checked at 320px for the topbar (nav wraps). | 🟢 Minor | Test at 320px and 200% zoom; consider a menu button below 600px. |

## Priority
1. Fix #3 before launch: the interest rule must be visible wherever money is requested.
2. Fix #2 and #4 for the verification and nominee flows, which are the core trust steps.
3. Address #1, #5, #6 in the next iteration.
