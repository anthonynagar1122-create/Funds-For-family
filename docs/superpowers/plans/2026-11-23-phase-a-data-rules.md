# Phase A: Data Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interest-and-dollars ledger with the approved rules: rupees, limits, trusted-contact consent, two-step confirmation, per-lender repayment, mutual-only visibility and invite-only joining. The rules are enforced in pure functions, both repositories, the database and the API.

**Architecture:** Pure rules in `src/rules.js` plus a shared `public/app/money.js`, used by the server and the browser. The repository contract is implemented twice: `src/memory-repo.js` for tests and `src/supabase-repo.js` for staging and production. The Express API in `src/app.js` enforces the rules and visibility. Migration `0002` is additive and goes to staging only.

**Tech Stack:** Node 22, Express 4, `node:test`, Supabase Postgres (service key, RLS on with no policies), Playwright (existing browser tests).

**Spec:** `docs/superpowers/specs/2026-11-23-customer-ready-design.md` (sections 5, 6, 7). Also `docs/15-product-decisions.md`.

## Global Constraints

- Money is integer paise. JS fields keep the `…Cents` suffix (`principalCents`, `amountCents`) and mean paise. API inputs `amount` are rupees, a number or string with at most 2 decimals.
- Display: `₹` with Indian grouping, always 2 decimals: `formatInr(10000000) === '₹1,00,000.00'`.
- Request amount: 10,000 to 5,000,000 paise (₹100 to ₹50,000).
- Due date: after today and on or before today plus 12 calendar months. "Today" is the calendar date in Asia/Kolkata (UTC+05:30, no daylight saving).
- Purpose: 20 to 2,000 characters. Category is one of `education`, `medical`, `home`, `family_event`, `work`, `emergency`, `other`.
- One active request per borrower. Active means `awaiting_contact`, `contact_declined`, `pending_verification`, `open` or `funded`.
- A trusted contact must be a mutual connection of the borrower, and may be named on at most 3 active requests.
- A rejection reason is 10 to 500 characters. A UTR is `^[A-Za-z0-9]{6,35}$`. A UPI ID is `^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$`.
- Invites: a 32-byte random token; only its SHA-256 hex is stored; expires after 14 days; single use; 5 per member per calendar month (IST) by default, overridden by `users.inviteLimit`. Revoked and superseded invites do not count.
- No interest anywhere: remove `interestCents`, `amountDueCents`, `DEFAULT_ANNUAL_RATE`, `annualRate` and `INTEREST_RATE_ANNUAL`.
- API errors keep the shape `{ error, field? }`. User-facing words say "trusted contact", never "nominee" or "guarantor".
- Never apply migrations to, or run tests against, production `enqxchwiqfdqwrvuqlph`. Staging is `sgtfdoiauximmktdhrxb`.
- Out of scope for Phase A (Phase C): new due dates, thank-you notes, trust history, receipts, admin routes, help, settlement, cron, account deletion, email preferences. Columns for these are added by migration 0002, but no routes yet.

## Review Focus

1. **Amount typed the Indian way** (`"1,500"`, `"₹1,500.50"`, `" 500 "`): accepted as ₹1,500, ₹1,500.50 and ₹500. `"1.234"`, `"-5"`, `"abc"` and `""` are rejected with a field error (Task 1).
2. **Late evening in India**: at `2026-11-23T20:00:00Z` it is already 24 November in IST, so a due date of 2026-11-24 is rejected as "not after today" (Task 2).
3. **Double confirmation or over-funding**: confirming the same contribution twice is a no-op 200, and a contribution that would push `sent`+`confirmed` over the principal is rejected with 409 (Task 7).
4. **Someone else's IDs (IDOR)**: confirming, editing or deleting a contribution or repayment that isn't yours returns 403. Reading a request you can't see returns 404, not 403 (Tasks 7, 8, 9).
5. **Re-used, expired, revoked or wrong invite token**: returns 403 "invite only", and a used token cannot admit a second person (Task 5).

---

## File map

- Create `public/app/money.js`: `formatInr`, `parseRupees` (UMD, works in the browser and in Node).
- Modify `src/rules.js`: date (IST), request, consent, verification, contribution, repayment and visibility rules. Remove interest.
- Create `supabase/migrations/0002_customer_ready.sql`.
- Modify `src/memory-repo.js` and `src/supabase-repo.js`: the new contract (Task 4).
- Create `src/invites.js`: token hashing and allowance logic.
- Modify `src/app.js`: admission, routes, visibility, response shapes.
- Modify `src/services.js`: pass `ownerEmail` from `OWNER_EMAIL`, drop `annualRate`.
- Modify `public/app.js`, `public/app/card-model.js` and `public/app/index.html`: minimal compatibility (rupees, trusted contact, category, sent and confirmed amounts). The redesign is Phase B.
- Tests: `test/money.test.js`, `test/rules.test.js` (rewritten), `test/repo-contract.test.js`, `test/invites.test.js`, `test/api.test.js` and `test/security.test.js` (updated), `test/integration/supabase.integration.test.js` (extended).
- Create `test/helpers/harness.js`: the shared API test harness (moves `setup()` out of `api.test.js` and `security.test.js`).

---

### Task 1: Rupee money helpers

**Files:** Create `public/app/money.js`, `test/money.test.js`.

**Interfaces:**
- Produces: `formatInr(paise: integer) -> string` and `parseRupees(input: number|string) -> { paise: integer } | { error: string }`. Exported with `module.exports` in Node and as `window.Money` in the browser.

- [ ] **Step 1: Write the failing tests** in `test/money.test.js`:
  - `formatInr(0) === '₹0.00'`, `formatInr(150) === '₹1.50'`, `formatInr(10000000) === '₹1,00,000.00'`, `formatInr(123456789) === '₹12,34,567.89'`, `formatInr(5000000) === '₹50,000.00'`.
  - `parseRupees('1,500')` → `{paise:150000}`; `'₹1,500.50'` → `{paise:150050}`; `' 500 '` → `{paise:50000}`; `500` → `{paise:50000}`; `'0.1'` → `{paise:10}`.
  - `'1.234'`, `'-5'`, `'abc'`, `''`, `'0'`, `null` and `'1e3'` each return an object with an `error` string.
- [ ] **Step 2:** Run `node --test test/money.test.js`. Expected: FAIL, "Cannot find module".
- [ ] **Step 3: Implement.** Strip `₹`, commas and surrounding spaces; require `^\d+(\.\d{1,2})?$`; convert with string arithmetic (never `n*100` floats); reject 0. `formatInr` groups the last 3 digits, then pairs.
- [ ] **Step 4:** Run `node --test test/money.test.js`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat: rupee formatting and parsing`.

### Task 2: Request and consent rules (IST dates, limits, no interest)

**Files:** Modify `src/rules.js`; rewrite `test/rules.test.js`.

**Interfaces:**
- Consumes: `parseRupees` (Task 1).
- Produces, all pure:
  - `AMOUNT_MIN_PAISE = 10000`, `AMOUNT_MAX_PAISE = 5000000`, `CATEGORIES` (array), `ACTIVE_STATUSES` (array), `MAX_ACTIVE_AS_CONTACT = 3`.
  - `todayIst(now: Date) -> 'YYYY-MM-DD'`, `addMonths(date: 'YYYY-MM-DD', n) -> 'YYYY-MM-DD'` (clamped to the month end, so 2026-01-31 + 1 = 2026-02-28).
  - `validateRequest(input, { borrowerId, now }) -> { errors, value }`, where `value = { principalCents, purpose, category, repaymentDate, trustedContactId }`.
  - `checkCanCreateRequest({ borrowerActiveCount }) -> {ok, reason?}`.
  - `checkTrustedContact({ borrowerId, contactId, isMutual, contactActiveCount }) -> {ok, reason?}`.
  - `validateVerification({ decision, reason }) -> {errors, value}` (reason required for reject, 10 to 500 characters).
  - `verificationOutcome(verifications, required)` and `canVerify({ verifier, borrowerId, trustedContactId, status })` (renamed parameters).
  - `effectiveStatus(request, now)`: `overdue` when `funded` and `todayIst(now) > repaymentDate`.
  - Remove `interestCents`, `amountDueCents`, `DEFAULT_ANNUAL_RATE`, `FEED_MODE` and `isFeedStatus`; visibility moves to Task 3.

- [ ] **Step 1: Write the failing tests** (`now = 2026-11-23T06:00:00Z` unless stated):
  - `todayIst(new Date('2026-11-23T20:00:00Z')) === '2026-11-24'`; `todayIst(new Date('2026-11-23T18:29:59Z')) === '2026-11-23'`.
  - The amount rejects ₹99.99 and ₹50,000.01 and accepts ₹100 and ₹50,000 (`principalCents` 10000 and 5000000).
  - Dates: `'2026-11-23'` is rejected ("after today"); `'2027-11-23'` is accepted; `'2027-11-24'` is rejected ("within 12 months"). At `2026-11-23T20:00:00Z`, `'2026-11-24'` is rejected.
  - Category `'travel'` is rejected with field `category`; `'medical'` is accepted.
  - `trustedContactId` missing → field `trustedContactId`; equal to `borrowerId` → rejected.
  - `checkCanCreateRequest({borrowerActiveCount:1}).ok === false`; `0` → true.
  - `checkTrustedContact`: `isMutual:false` → false; `contactActiveCount:3` → false; `2` and mutual → true.
  - `validateVerification({decision:'reject', reason:'short'})` → error on `reason`; `'approve'` without a reason → ok.
  - `effectiveStatus({status:'funded', repaymentDate:'2026-11-23'}, new Date('2026-11-23T19:00:00Z')) === 'overdue'`. In IST that is 24 November, so this verifies the IST boundary.
  - `require('../src/rules').interestCents === undefined`.
- [ ] **Step 2:** Run `node --test test/rules.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/rules.js`. IST "today" is `new Date(now.getTime() + 330*60000).toISOString().slice(0,10)`. Error text, verbatim: amount `'Enter an amount from ₹100 to ₹50,000'`; date `'Choose a date within 12 months'` and `'Repayment date must be after today'`; contact `'Choose a trusted contact'`; one-active `'You already have an active request. Finish or withdraw it first.'`; contact load `'This person is already the trusted contact on 3 requests'`; not mutual `'Your trusted contact must be someone you follow who follows you back'`.
- [ ] **Step 4:** Run `node --test test/rules.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: request limits, IST dates, trusted contact rules; remove interest`.

### Task 3: Money-flow and visibility rules

**Files:** Modify `src/rules.js`, `test/rules.test.js`.

**Interfaces:**
- Produces:
  - `ENTRY_STATUSES = ['sent','confirmed','not_received']`; `validateUtr(s) -> boolean` (empty or missing is allowed).
  - `fundingTotals(contributions) -> { confirmedCents, pendingCents }` (pending = `sent`; `not_received` is excluded).
  - `checkContribution({ amountCents, principalCents, totals, contributorId, borrowerId, isMutual, status }) -> {ok, reason?, remainingCents}`. The cap is `principal - confirmed - pending`. The status must be `open`.
  - `owedByLender(contributions, repayments) -> Map<lenderId, { lentCents, repaidCents, pendingRepayCents, owedCents }>` (confirmed only for lent and repaid; `owedCents = lent - repaid`).
  - `checkRepayment({ amountCents, payerId, borrowerId, trustedContactId, lenderId, owed, status }) -> {ok, reason?}`. Allowed when `funded`, the payer is the borrower or trusted contact, and `amount ≤ owedCents - pendingRepayCents`.
  - `isFullyRepaid(owedMap) -> boolean` (every `owedCents === 0` and the map is not empty).
  - `isMutual(connections: {following, followers}, otherId) -> boolean`.
  - `canSeeRequest({ viewerId, request, isMutualWithBorrower, isLender, viewerIsVerifier }) -> boolean`. True for the borrower, the trusted contact and lenders; for verifiers while `pending_verification`; for mutual connections while `open`, `funded` or `repaid`.
  - `paymentTargetVisible({ viewerId, ownerId, request, lenderIds }) -> boolean`, for the UPI ID rule in spec 5.6.
- [ ] **Step 1: Write the failing tests:**
  - `fundingTotals([{amountCents:500,status:'confirmed'},{amountCents:300,status:'sent'},{amountCents:900,status:'not_received'}])` → `{confirmedCents:500, pendingCents:300}`.
  - With principal 1000 and those totals: 200 is ok; 201 is rejected with `remainingCents: 200`. Not mutual → rejected. The borrower → rejected. Status `funded` → rejected.
  - `owedByLender` with lender 7 confirmed 1000, repaid confirmed 400 and sent 100 → `owedCents:600`, `pendingRepayCents:100`. `checkRepayment` with amount 500 → ok; 501 → rejected; payer 99 → rejected.
  - `isFullyRepaid` of an empty map is false; with all owed at 0 it is true.
  - `canSeeRequest`: a stranger is false for every status; a mutual connection is false on `pending_verification` and true on `open`; a verifier is true on `pending_verification` and false on `open` unless otherwise connected.
- [ ] **Step 2:** Run `node --test test/rules.test.js`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the pure functions.
- [ ] **Step 4:** Run `node --test test/rules.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: two-step funding, per-lender repayment and visibility rules`.

### Task 4: Migration 0002 and repository contract

**Files:** Create `supabase/migrations/0002_customer_ready.sql` and `test/repo-contract.test.js`; modify `src/memory-repo.js`, `src/supabase-repo.js`, `test/integration/supabase.integration.test.js`.

**Interfaces (the repository contract):** every method is async and returns camelCase objects. A request returns `trustedContactId` (column `nominee_id`), `category`, `fundedCents`, `rejectionReason`.
- Users: `findUserByClerkId(clerkId)`, `createUser({clerkId,name,email,avatarUrl,isAdmin,isVerifier})`, `updateUser(id, patch)` (`name`, `upiId`, `avatarUrl`, `welcomedAt`, `termsAcceptedAt`), `getUser(id)`, `getUsers(ids)`, `searchUsers(q, excludeId)`, `setVerifier(id, on)`.
- Follows: `addFollow`, `removeFollow`, `connections(userId)` (unchanged).
- Invites: `createInvite({inviterId,email,tokenHash,expiresAt,createdAt})`, `findInviteByHash(hash)`, `findOpenInvitesByEmail(email)`, `listInvitesByInviter(id)`, `getInvite(id)`, `updateInvite(id, patch)` (`acceptedAt`, `acceptedUserId`, `revokedAt`, `supersededAt`), `countInvitesSince(inviterId, isoDate)` (excludes revoked and superseded).
- Requests: `createRequest(row)`, `getRequest(id)`, `updateRequest(id, patch)` (replaces `setRequestStatus`), `listRequestsByBorrowers(ids)`, `listRequestsForMember(userId)` (also matches the trusted contact and repayment lender), `countActiveByBorrower(id)`, `countActiveAsContact(id)`.
- Verifications: `addVerification({requestId, verifierId, decision, note, createdAt})`, `listVerifications(requestId)`.
- Contributions: `addContribution({requestId,contributorId,amountCents,utr,status:'sent',createdAt})` returns the row with `id`; `getContribution(id)`; `updateContribution(id, patch)`; `deleteContribution(id)`; `listContributions(requestId)`.
- Repayments: the same set with `payerId` and `lenderId`: `addRepayment`, `getRepayment`, `updateRepayment`, `deleteRepayment`, `listRepayments`.

- [ ] **Step 1: Write the migration** exactly as spec section 6 lists, including the P-37 to P-44 columns (`category`, `avatar_url`, `email_reminders`, `email_thanks`, `help_messages`) and the Phase C tables (`date_changes`, `date_change_votes`, `notes`, `notifications_sent`). In detail:
  - Each new table gets RLS enabled and `revoke all … from anon, authenticated`.
  - Index every new foreign key.
  - Drop and recreate the `requests_status_check` constraint with the 8 statuses.
  - Add `principal_cents between 10000 and 5000000` as `not valid`.
  - Add the partial unique index `requests_one_active_per_borrower`.
  - Leave `category` nullable, with a check list allowing null.
  - Start the file with a comment that `*_cents` columns hold paise.
- [ ] **Step 2: Write the failing contract test** `test/repo-contract.test.js`. It exports `runContract(makeRepo)` and runs it against `createMemoryRepo`. Cases:
  - create a user, then find it by `clerkId`;
  - `countInvitesSince` excludes a revoked invite;
  - `addContribution` returns an `id` and status `sent`, and `updateContribution(id,{status:'confirmed'})` round-trips;
  - `countActiveByBorrower` counts `open` but not `rejected`;
  - `countActiveAsContact` counts `awaiting_contact`;
  - `listRequestsForMember` includes a request where the member is a repayment lender.
- [ ] **Step 3:** Run `node --test test/repo-contract.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/memory-repo.js` to the contract. Remove `upsertUser` and `setRequestStatus`.
- [ ] **Step 5:** Run `node --test test/repo-contract.test.js`. Expected: PASS.
- [ ] **Step 6: Implement** `src/supabase-repo.js` to the same contract (snake_case ↔ camelCase mapping in one `toRequest`, `toUser` and `toEntry` helper each). Make `test/integration/supabase.integration.test.js` also call `runContract(() => createSupabaseRepo(...))`; it stays skipped without credentials and refuses the production ref.
- [ ] **Step 7: Apply the migration to staging only** with the Supabase MCP `apply_migration` (project `sgtfdoiauximmktdhrxb`, name `customer_ready`). Then run `get_advisors` security and performance. Expected: only the INFO `rls_enabled_no_policy` notices. Fix any unindexed-foreign-key warning in the same file and re-apply as `customer_ready_indexes`.
- [ ] **Step 8:** Commit: `feat: migration 0002 and repository contract`.

### Task 5: Invite-only admission and invites API

**Files:** Create `src/invites.js`, `test/invites.test.js`, `test/helpers/harness.js`; modify `src/app.js`, `src/services.js`, `test/api.test.js`, `test/security.test.js` and the other tests that build an app.

**Interfaces:**
- Produces `src/invites.js`:
  - `newToken() -> { token, tokenHash }` (`crypto.randomBytes(32)` as base64url; the hash is a SHA-256 hex);
  - `hashToken(token) -> string`;
  - `monthStartIst(now) -> ISO string` (the first of the IST month at 00:00 IST, expressed in UTC);
  - `inviteState(invite, now) -> 'open'|'accepted'|'revoked'|'superseded'|'expired'`.
- `createApp` gains `ownerEmail` (string or empty) and `admit` (an optional async `(identity) => boolean`, default `async () => false`). The test harness passes `admit: async () => true` so the old tests keep their implicit sign-up. `identify` may return `avatarUrl`.
- Admission in `requireUser`: find by `clerkId`. If missing, admit when one of these holds, otherwise answer 403 `{error:'Funds For Family is invite only. Ask someone who uses it to send you an invite.', code:'invite_only'}`:
  - the email equals `ownerEmail` (case-insensitive); the member is created with `isAdmin` and `isVerifier` true;
  - the request has header `x-invite-token`, whose hash matches an `open` invite;
  - an `open` invite exists for the identity email;
  - `admit(identity)` returns true.
- On invite admission: mark the invite accepted, add follows both ways, and mark other open invites for the same email `superseded`.
- Routes:
  - `POST /api/invites {email}` → 201 `{ invite:{id,email,expiresAt}, link: appUrl + '/app/#join=' + token, whatsappUrl, remainingThisMonth }`. Over the allowance → 429 `'You have used all your invites this month'`. Inviting an existing member's email → 409.
  - `GET /api/invites` → mine, with `state`.
  - `DELETE /api/invites/:id` → revoke (inviter only, otherwise 404).
- The browser stores `#join=<token>` in `sessionStorage` and sends it as `x-invite-token` on its first `/api/me` (Task 10).

- [ ] **Step 1:** Move `setup()` into `test/helpers/harness.js` with options `{ admitAll = true, ownerEmail = '', now }`. Point `api.test.js`, `security.test.js` and every other app-building test at it. Run `npm test`. Expected: same results as before (green, apart from the tests for code changed in Tasks 2 and 3).
- [ ] **Step 2: Write the failing tests** in `test/invites.test.js` (harness with `admitAll:false`, `ownerEmail:'owner@example.com'`):
  - `owner` signs in → 200, `isAdmin` true. `stranger` signs in → 403 with `code:'invite_only'`.
  - The owner invites `kim@example.com` → 201. Response `link` matches `/#join=[A-Za-z0-9_-]{43}$/`, and `whatsappUrl` starts with `https://wa.me/?text=`.
  - `kim` (email `kim@example.com`) signs in with no token → 200 (email match). `/api/connections` shows the owner in `mutual`.
  - A token used by `lee` (different email) → 200. The same token used by `max` → 403.
  - An expired token (clock +15 days) → 403. A revoked token → 403.
  - The 6th invite in a month → 429. A revoked invite frees a slot.
  - Two members invite `zed@example.com`; zed joins with A's token → B's invite state is `superseded` and A and zed are mutual.
  - The database stores no raw token: no invite row in `repo._state` contains the token string.
- [ ] **Step 3:** Run `node --test test/invites.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/invites.js`, the admission logic in `requireUser`, and the routes. `services.js` passes `ownerEmail: env.OWNER_EMAIL || ''` and maps the Clerk `imageUrl` to `avatarUrl` in `identify`.
- [ ] **Step 5:** Run `node --test test/invites.test.js test/api.test.js test/security.test.js`. Expected: PASS for the invite tests. `api` and `security` failures are allowed only where Tasks 6 to 9 change behaviour; list them in the commit message.
- [ ] **Step 6:** Commit: `feat: invite-only joining with hashed one-time tokens`.

### Task 6: Request lifecycle API

**Files:** Modify `src/app.js`, `test/api.test.js`.

**Interfaces:**
- Consumes the Task 2 and 3 rules and the Task 4 repo.
- Request JSON (`summarise`): `{ id, borrowerId, trustedContactId, category, purpose, principalCents, fundedCents, repaymentDate, status, createdAt, rejectionReason? }`. `rejectionReason` is shown only to the borrower.
- Routes:
  - `POST /requests {amount, purpose, category, repaymentDate, trustedContactId}` → 201 with status `awaiting_contact`. Errors: 400 with a field; 409 for one-active, contact load or not-mutual (field `trustedContactId`). The trusted contact gets an email.
  - `POST /requests/:id/contact-decision {decision:'accept'|'decline'}` (trusted contact only, status `awaiting_contact`): accept → `pending_verification`; decline → `contact_declined`.
  - `POST /requests/:id/trusted-contact {userId}` (borrower, status `contact_declined`): runs the same checks, then `awaiting_contact`.
  - `POST /requests/:id/verify {decision, reason?}`: a reject needs a reason, stored as the verification note and on the request as `rejectionReason`.
  - `POST /requests/:id/withdraw` (borrower; status in `awaiting_contact`, `contact_declined`, `pending_verification` or `open`, with no confirmed contribution) → `withdrawn`.
  - `POST /requests/:id/close` (borrower, `open`, confirmed > 0) → `funded`, with `fundedCents` set to confirmed, `fundedAt` set, and pending `sent` entries left as they are.
  - `GET /requests/:id`: 404 unless `canSeeRequest`.
- [ ] **Step 1: Write the failing tests**, using a helper `connect(a,b)` that follows both ways:
  - creating with a non-mutual contact → 409, field `trustedContactId`;
  - a second create while the first is `awaiting_contact` → 409 with the one-active message;
  - a 4th request naming the same contact (three different borrowers, each active) → 409;
  - contact accepts → `pending_verification`; a stranger calling contact-decision → 404;
  - decline, re-pick a new mutual contact → `awaiting_contact`;
  - reject without a reason → 400 on field `reason`; reject with a reason → `rejected`, the borrower sees `rejectionReason`, the trusted contact's view omits it, and the borrower can create a new request at once;
  - withdraw after a confirmed contribution → 409;
  - close with ₹300 confirmed of ₹1,000 → `funded`, `fundedCents` 30000;
  - `GET` by a stranger → 404.
- [ ] **Step 2:** Run `node --test test/api.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the routes. Replace `formatCents` with `formatInr`. Email subjects: `'<name> named you as their trusted contact'`, `'Your Funds For Family request was approved'`, `'Your Funds For Family request was not approved'` (body includes the reason).
- [ ] **Step 4:** Run `node --test test/api.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: request lifecycle with trusted-contact consent, reasons, withdraw and close`.

### Task 7: Two-step contributions API

**Files:** Modify `src/app.js`, `test/api.test.js`, `test/security.test.js`.

**Interfaces:**
- Contribution JSON: `{ id, requestId, contributorId, amountCents, utr, status, createdAt, confirmedAt }`.
- Routes:
  - `POST /requests/:id/contributions {amount, utr?}` → 201 `sent`. The borrower gets the email `'<name> says they sent ₹X. Please confirm.'`.
  - `POST /contributions/:id/confirm` (borrower only). Idempotent: a second call → 200, unchanged. When confirmed reaches the principal → `funded`, with `fundedCents` = principal.
  - `POST /contributions/:id/not-received` (borrower only; only from `sent`).
  - `PATCH /contributions/:id {amount?, utr?}` (contributor only; only while `not_received`) → back to `sent`.
  - `DELETE /contributions/:id` (contributor only; not when `confirmed`).
  - For these routes, a contribution on a request the caller cannot see → 404; visible but not the caller's role → 403.
  - Add `patch` to the `wrapAsync` method list.
- [ ] **Step 1: Write the failing tests:**
  - lend as a non-mutual member → 409;
  - sent 600 plus sent 400 on ₹1,000 → both ok, then a third of ₹1 → 409;
  - confirm both → `funded`;
  - confirming twice → 200 and the confirmed total is unchanged;
  - not-received → patch amount → `sent`; delete a `confirmed` entry → 409;
  - a UTR of `'ab'` → 400 on field `utr`;
  - in `security.test.js`: a lender confirming their own contribution → 403; another lender's PATCH → 403; a stranger's confirm → 404.
- [ ] **Step 2:** Run `node --test test/api.test.js test/security.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: two-step contributions (sent, then received)`.

### Task 8: Per-lender repayments API

**Files:** Modify `src/app.js`, `test/api.test.js`, `test/security.test.js`.

**Interfaces:**
- Repayment JSON: `{ id, requestId, payerId, lenderId, amountCents, utr, status, createdAt, confirmedAt }`.
- Routes:
  - `POST /requests/:id/repayments {lenderId, amount, utr?}` (borrower or trusted contact, `funded`, `checkRepayment`) → 201 `sent`. The lender gets the email `'<name> says they repaid you ₹X. Please confirm.'`.
  - `POST /repayments/:id/confirm` and `not-received` (the lender only), and `PATCH` and `DELETE` (the payer only), mirroring Task 7.
  - When `isFullyRepaid` → `repaid`, with `repaidAt` set.
- [ ] **Step 1: Write the failing tests:**
  - lenders A (₹600 confirmed) and B (₹400 confirmed);
  - repay A ₹200 three times as instalments, A confirms each, then a fourth of ₹1 → 409;
  - repaying B ₹400 by the trusted contact → ok, B confirms → `repaid`;
  - a repayment to a non-lender → 409;
  - a stranger as payer → 403 (or 404 if not visible);
  - B confirming A's repayment → 403.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: per-lender repayments in instalments with lender confirmation`.

### Task 9: Feed, profile, home and member privacy

**Files:** Modify `src/app.js`, `test/api.test.js`, `test/security.test.js`.

**Interfaces:**
- `publicUser(u, viewerId)` → `{id, name, avatarUrl, isVerifier}`, plus `email`, `upiId`, `isAdmin`, `welcomedAt` and `termsAcceptedAt` for the owner of the profile only.
- Request detail adds `contributions`, `repayments`, `totals: {confirmedCents, pendingCents}`, `lenders: [{ userId, lentCents, repaidCents, pendingRepayCents, owedCents }]`, `payTo`. `payTo` is `{ userId, name, upiId }` entries that pass `paymentTargetVisible`: the borrower's UPI for lenders and for a mutual viewer while `open`; lenders' UPI for the borrower and trusted contact.
- Routes:
  - `GET /feed` → the caller's own requests (any status) plus those of mutual connections with status `open`, `funded` or `repaid`. Each item adds `totals`.
  - `GET /users` with an empty `q` → mutual connections only.
  - `GET /users/:id` → 404 for a non-member.
  - `PATCH /me {name?, upiId?}`: the name is 1 to 120 characters; an invalid UPI → 400 on field `upiId`; an empty string clears it.
  - `POST /me/accept-terms`, `POST /me/welcomed`.
  - `GET /home` → `{ needsYou: [...], myRequests: [...], myLending: [...] }`. `needsYou` item kinds: `confirm_contribution`, `confirm_repayment`, `fix_contribution`, `fix_repayment`, `contact_decision`, `verify`, `repick_contact`. Each has `requestId`, `entryId?`, `amountCents?`, `fromUserId?`.
  - `GET /activity` stays, updated (`roles.trustedContact` replaces `roles.nominee`; amounts are confirmed only).
- [ ] **Step 1: Write the failing tests:**
  - A follows B only → B's request is not in A's feed; after mutual → it is;
  - A sees B's `upiId` in `payTo` on B's open request; C (not mutual) gets 404 on the request;
  - `GET /users/:id` for another member has no `email` and no `upiId`;
  - `PATCH /me {upiId:'bad'}` → 400;
  - `/home` for the borrower after a `sent` contribution contains `confirm_contribution` with that `entryId`; for a verifier with a `pending_verification` request it contains `verify`; for the trusted contact it contains `contact_decision`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: mutual-only feed, member privacy, profile and home endpoint`.

### Task 10: Browser compatibility and full verification

**Files:** Modify `public/app.js`, `public/app/card-model.js`, `public/app/index.html`, and the browser tests that assert dollar or nominee text (`test/card-model.test.js`, `test/feed-cards.test.js`, `test/detail-*.test.js`, `test/activity*.test.js`, `test/app-wiring.test.js`, `test/prototype.e2e.test.js` only if it reads `/app`).

**Interfaces:**
- Load `/app/money.js` before `card-model.js`. `CardModel.requestCard` uses `Money.formatInr`, reads `totals.confirmedCents` for progress, and labels the role `trustedContact`.
- The form gains a `category` select, the field `trustedContactId` (label "Trusted contact"), an amount input with `inputmode="decimal"` and the hint "₹100 to ₹50,000", and a date input with `max` set to 12 months ahead.
- On load, `#join=<token>` is moved into `sessionStorage['ffjoin']` and sent as `x-invite-token` on the first `/api/me`. A 403 with `code === 'invite_only'` shows a "Not invited" view.
- Request detail shows confirmed and pending amounts, per-lender rows, the confirm and not-received buttons for the borrower, and "I've sent it" with an optional UTR for lenders. Minimal markup; the Phase B redesign replaces it.

- [ ] **Step 1: Update the browser tests first** to the new labels and amounts (`₹`, "Trusted contact", confirmed totals) and add: the `#join=abc` hash becomes header `x-invite-token: abc` on the first `/api/me` (mocked route assertion); a 403 `invite_only` shows text matching `/invite only/i`.
- [ ] **Step 2:** Run `npm test`. Expected: the updated browser tests FAIL.
- [ ] **Step 3: Implement** the front-end changes.
- [ ] **Step 4:** Run `npm test`. Expected: the whole suite passes, 0 skipped except tests gated on credentials. Re-run the landing visual tests and confirm they are unchanged. If app visual baselines changed, inspect the screenshots, then run with `UPDATE_VISUAL=1`.
- [ ] **Step 5: Mutation check.** Temporarily change `AMOUNT_MAX_PAISE` to 5000001, remove the `isMutual` check in `checkContribution`, and make `confirm` skip the borrower check, one at a time. Each time `npm test` must fail. Restore.
- [ ] **Step 6: Independent review.** Dispatch fresh `backend-design:security-reviewer` and `superpowers:requesting-code-review` agents on the diff from the commit that added this plan to `HEAD`. Fix the confirmed findings test-first.
- [ ] **Step 7: Staging integration.** If `SUPABASE_URL` (staging) and the secret key are available to CI, run `npm run test:integration` there. Otherwise record it as NOT RUN in the commit, with the reason.
- [ ] **Step 8:** Commit and push to `claude/gifted-thompson-e3onnq` only: `feat: browser uses rupees, trusted contact and two-step confirmation`.
