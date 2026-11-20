# Member workflow cards and activity ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every member role the right cards and actions for each request, and a personal activity ledger, with tests written first.

**Architecture:** A pure card model (`public/app/card-model.js`) decides what a request card shows and which actions a viewer may take, from the request's status and the viewer's role on it. A new API route (`GET /api/activity`) builds the ledger from the same data. The app page renders both. The pure parts are tested in Node; the page wiring is verified in a signed-in browser session, which this environment cannot provide.

**Tech Stack:** Node 22, Express 4, node:test, the existing in-memory repository, plain browser JavaScript.

**Spec:** docs/14-end-to-end-spec-and-workflow.md (journeys J3–J7, sections 4 and 5); docs/03-specifications.md.

## Global Constraints

- Amounts are integer cents. Display formatting is `$` with two decimals.
- A verifier cannot decide on a request where they are the borrower or nominee.
- Only the borrower or nominee may record repayments, and only on a funded request.
- Contributions are refused to the borrower; capped at the remaining balance; only while open.
- Email is visible only to its owner. Never add an email to a card or a ledger row.
- Ledger rows must not mix recorded commitments with confirmed cash: the ledger says "recorded", never "paid out".
- Node 22; no new runtime dependencies.

## Review Focus

1. A borrower viewing their own request must never see a verify or contribute action (role separation).
2. A nominee viewing the request must never see a verify action on it.
3. A completed (repaid) request must offer no write actions to anyone.
4. A ledger for a member with no activity returns empty lists, not an error.
5. A member who is both lender and borrower on different requests sees the correct role on each.

---

### Task 1: Card model (what each request card shows and allows)

**Files:**
- Create: `public/app/card-model.js` (pure; UMD-style export so Node tests and the browser both load it)
- Test: `test/card-model.test.js`

**Interfaces:**
- Produces: `requestCard(request, viewer) -> { title, statusLabel, tone, progressPct, raisedLabel, dueLabel, role, actions }`
  - `request`: `{ id, borrowerId, nomineeId, purpose, principalCents, repaymentDate, status, raisedCents, amountDueCents, daysOverdue }`
  - `viewer`: `{ id, isVerifier }`
  - `role`: one of `borrower`, `nominee`, `verifier`, `member`
  - `actions`: array of `{ id, label, tone }` where `id` is one of `verify-approve`, `verify-reject`, `contribute`, `repay`, `view`
  - `statusLabel` and `tone` map: pending_verification→"Awaiting verification"/warn; rejected→"Rejected"/danger; open→"Open for funding"/neutral; funded→"Funded"/ok; overdue→"Overdue"/danger; repaid→"Repaid"/ok
  - `progressPct` = floor(raisedCents / principalCents × 100), capped at 100, 0 when principal is 0
  - `raisedLabel` = "$X of $Y raised"

- [ ] **Step 1: Write the failing tests** (`test/card-model.test.js`)

Each test name states one behaviour. Use these exact cases:

```js
test('a borrower sees no verify or contribute actions on their own request', ...);
test('a nominee sees no verify action on the request they are named on', ...);
test('a verifier who is neither borrower nor nominee sees verify actions while pending', ...);
test('a verifier sees no verify action once the request is no longer pending', ...);
test('a member sees contribute only on an open request they did not create', ...);
test('a repaid request offers no write actions to anyone', ...);
test('the nominee sees repay only on a funded or overdue request', ...);
test('progress is capped at 100 and is 0 for a zero principal', ...);
test('status labels and tones match the lifecycle', ...);
```

- [ ] **Step 2: Run the tests; confirm they fail**
  Run: `node --test test/card-model.test.js`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `requestCard` in `public/app/card-model.js`**
  Pure function; no DOM. Derive `role` (borrower beats nominee beats verifier beats member when a user holds several). Derive actions from the rules in Global Constraints. Export with `module.exports` when `typeof module !== 'undefined'`, and attach to `window.CardModel` otherwise.

- [ ] **Step 4: Run tests; confirm they pass**
  Run: `node --test test/card-model.test.js`
  Expected: 9 passing.

- [ ] **Step 5: Commit**
  `git add public/app/card-model.js test/card-model.test.js && git commit -m "feat: request card model with role-based actions"`

---

### Task 2: Activity ledger API (`GET /api/activity`)

**Files:**
- Modify: `src/app.js` (add route after `GET /feed`)
- Test: `test/activity.test.js`

**Interfaces:**
- Consumes: `repo.listFeed`, `repo.listContributions`, `repo.listRepayments`, `repo.listVerifications`, `repo.getRequest`, `repo.getUser` (existing contract).
- Produces: `GET /api/activity` → `{ borrowing: Row[], lending: Row[], repayments: { made: Row[], received: Row[] }, roles: { nominee: Row[], verifier: Row[] } }`
  - `Row` = `{ requestId, purpose, status, principalCents, repaymentDate, myRole, myAmountCents }` where `myAmountCents` is the member's own recorded contribution or repayment total on that request (0 when not applicable).
- Access: signed-in members only (401 otherwise). Data is limited to requests the member borrowed, lent to, repaid, or holds a role on.

- [ ] **Step 1: Write the failing tests** (`test/activity.test.js`), using the same in-memory setup as `test/api.test.js`:

```js
test('activity is refused without a signed-in member', ...);            // 401
test('a new member gets empty ledger lists, not an error', ...);        // all arrays []
test('a borrower sees their request under borrowing', ...);
test('a contributor sees the request under lending with their own total', ...);
test('repayments made and received are split by who recorded them', ...);
test('a nominee sees the request under roles.nominee', ...);
test('a verifier sees the request under roles.verifier, only when they decided', ...);
test('a stranger sees no rows for a request they had no part in', ...);
test('ledger rows never include email addresses', ...);
```

- [ ] **Step 2: Run; confirm failure**
  Run: `node --test test/activity.test.js`
  Expected: FAIL, 404 on `/api/activity`.

- [ ] **Step 3: Implement the route.** Collect the member's requests from the borrowed set and from contributions, repayments, verifications and nominee links. Build rows with `myAmountCents` and `myRole`. Keep the handler under 60 lines by moving row building into a helper inside `createApp`.

- [ ] **Step 4: Run; confirm pass, then the full suite**
  Run: `node --test test/activity.test.js && npm test`
  Expected: activity 9 passing; full suite 100+9 passing.

- [ ] **Step 5: Commit**
  `git add src/app.js test/activity.test.js && git commit -m "feat: member activity ledger API"`

---

### Task 3: Render the cards and ledger in the app page

**Files:**
- Modify: `public/app/index.html` (load `/app/card-model.js` before `app.js`; add a "My activity" view)
- Modify: `public/app.js` (feed and request detail render through `CardModel.requestCard`; add the activity view)

**Interfaces:**
- Consumes: `CardModel.requestCard` (Task 1); `GET /api/activity` (Task 2).

- [ ] **Step 1: Add a failing test** that the app page references the card model and the activity view, so the wiring cannot silently disappear (`test/app-wiring.test.js`, file-based).

- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Wire the page.** Replace direct status and action markup in the feed and detail renderers with the card model output. Add the activity view, which calls `/api/activity` and renders the four lists.
- [ ] **Step 4: Run the full suite.** Expected: all passing.
- [ ] **Step 5: Verify in a signed-in browser session.** This is a manual check that this environment cannot perform (no sign-in secret). Record it as UNVERIFIED in the ledger until it is run.
- [ ] **Step 6: Commit.**

---

## Self-review

- Spec coverage: J3 (request card), J4 (verifier card actions), J5 (contribute action), J6 (repay action), J7 (activity ledger) all have tasks. J8 (settings) and I-10 (verifier queue page) are out of scope and stay in the spec backlog.
- Type consistency: `requestCard` output names match between Task 1 and Task 3; `GET /api/activity` shape matches between Task 2 and Task 3.
- Review focus: each of the five items is covered by a named test in Task 1 or Task 2.
