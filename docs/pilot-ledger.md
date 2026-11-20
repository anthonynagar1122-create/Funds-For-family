# Pilot ledger: Funds for Family, member workflow Task 3

Statuses: `IMPLEMENTED` = code written. `TESTED` = automated checks ran and passed. `VERIFIED` = independent controller review and acceptance criteria passed.

| Item | Goal | Implementation | Test evidence | Controller review | Blockers | Status |
|---|---|---|---|---|---|---|
| Card model: decided verifier | A verifier who already decided gets no verify actions | `public/app/card-model.js` | `node --test test/card-model.test.js` (10 pass) | Caught by the test first, then fixed | none | TESTED |
| Card model: borrower repays | Borrower can record repayments on funded or overdue requests | `public/app/card-model.js` | card-model tests (11 pass) | Found by reading the detail page's old gate against the constraints | none | TESTED |
| Detail page uses card model | Forms come from the same rules as the cards | `public/app.js` `renderDetail` | `test/detail-wiring.test.js` (2 pass); browser tests below | Old duplicate gate removed | none | TESTED |
| Detail page in a browser (mocked) | Each role sees the right form | `test/detail-browser.e2e.test.js` | 6 pass; mutation check: forcing the verify form on fails 2 tests | Browser test uses MOCKED Clerk and API | Real sign-in not available | TESTED (mocked) |
| Real sign-in and real backend | Detail page works for a signed-in member against the real API | none | none | not reviewed | `CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` not set in production | IMPLEMENTED only |
| Real database path for participation lookup | `listRequestsForMember` works on Postgres | `src/supabase-repo.js` | in-memory tests only | not reviewed | staging project and service key | IMPLEMENTED only |
| Vercel preview deployment | Preview of this branch | none | none | not done | production branch is set to this feature branch, so pushes deploy to production; needs an approval decision | BLOCKED |

## Gate status
- Gate for the pilot as a whole: **not met**. The browser tests are mocked, and the real sign-in, backend and preview deployment have not been verified.
