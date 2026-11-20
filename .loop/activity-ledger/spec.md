# Spec: activity ledger page

## Problem / goal
Members need a "My activity" page that lists their borrowing, lending, repayments and roles, using the existing `GET /api/activity` route.

## Scope
- Change: `public/app/index.html` (nav entry and view), `public/app.js` (renderer and route).
- Non-goals: no backend change, no settings page, no real sign-in verification.

## Exit criteria (binary)
1. The page shows four groups (Borrowing, Lending, Repayments, Roles). An empty ledger shows an empty state, not an error.
2. Each row links to its request detail page (`#request/<id>`).
3. No email address appears anywhere on the page.
4. A stranger's ledger shows no rows for requests they had no part in. (Covered by the existing API test `stranger sees no rows`.)

## Verification plan
- Exit 1–3: Playwright test with a mocked Clerk and mocked `/api/activity`, plus the full suite.
- Exit 4: the existing API test, unchanged.

spec_approved: yes (user said "go ahead with loop A", 2026-11-21)
