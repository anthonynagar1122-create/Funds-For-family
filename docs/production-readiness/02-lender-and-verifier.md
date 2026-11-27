# Production readiness 02: lender and verifier journeys

Branch `claude/gifted-thompson-e3onnq` at 24dfd1c. Audit date 2026-11-27. Method: walked each journey through `src/app.js`, `src/rules.js`, `src/memory-repo.js`, `public/app.js` and `public/app/**`, then pinned the result in `test/journeys/lender-and-verifier.test.js` (7 passing tests, 23 `todo` gap tests, 0 failures). Authority: `docs/superpowers/specs/2026-11-23-customer-ready-design.md`, `docs/15-product-decisions.md`, `docs/release/phase-a-production-checklist.md`.

Legend: WORKS = matches spec, tested. PARTIAL = part of the step works. MISSING = no code. BROKEN = code exists but the person cannot complete the step, or it contradicts the spec. "API" = server behaviour; "UI" = what a person on a phone can reach.

Headline: the money rules (cap, two-step confirm, per-lender instalments, mutual-only, deletion block, owner settlement queue) are sound at the API. The lender journey is held back by the UI: the feed that lists mutual connections' open requests has no entry point, and "Fix" on a not-received payment lands on a page with no fix controls. Phase C (due-date votes, thank-you notes, receipts, daily job, reminder emails) has no code, although the screens already promise some of it.

## Lender journey

| Step | Status | Evidence | Impact on the person |
|---|---|---|---|
| Invited: opens one-time link, joins, becomes mutual with inviter | WORKS | `src/app.js:52-67` (acceptInvite), `:512-538` (create invite), `:70-110` (token or email admits); `public/app.js:7-12,31-33` | Link works whatever email they sign in with; inviter and lender can see each other at once. |
| Welcome: name, UPI ID, terms checkbox, connected-with line, rules, then Home | WORKS | `public/app/pages/welcome.js:30-120`; `src/app.js:451-461`; `public/app.js:160,189` | Three short steps; Home is gated until done. |
| Sees mutual connections' open requests in feed or Home | BROKEN | API ok: `src/app.js:558-572`, `src/rules.js:265-272`. UI orphan: `public/app.js:198` ("reachable at #/feed"), `:200` (Requests tab renders the activity ledger), `public/app/nav.js:37-43` (no feed tab), `public/app/pages/home.js:49-75` (needs, my requests, my lending only). No file links to `#/feed`. | A lender has no way to find a connection's open request unless someone sends them the request URL. The core "lend" step cannot start from the app. |
| Opens a request (mutual only, 404 otherwise) | WORKS | `src/rules.js:265-272`, `src/app.js:671-684`; journey test 2 | Strangers and one-way followers cannot see or fund it. |
| Pays by UPI link or QR with amount filled; "ask them to add UPI" fallback | WORKS | `public/app/pages/request.js:20-54,153-163`; `src/app.js:1148-1157`, `src/rules.js:278-289` | One tap on a phone, QR on desktop. Borrower's UPI ID shown only where needed. |
| Records "sent" with optional UTR; cap; borrower emailed | WORKS | `src/app.js:928-961`, `src/rules.js:171-203`; `request.js:197-206` | Over-sending refused (409), bad UTR refused (400), sent money not counted until confirmed. |
| Borrower confirms; or marks not received (lender emailed, Home shows "Fix") | WORKS | `src/app.js:963-993`, Home item `:598-600` (`fix_contribution`); `home.js:19` | Lender learns by email and on Home. |
| Fix: edit amount or UTR, or delete, after "not received" | BROKEN | API ok: `src/app.js:995-1030`. UI: `public/app/pages/request.js:103-106` renders only the borrower's Confirm and Not received buttons; no `Api.patch` or `Api.delete` anywhere in the page (same for repayments, `:107-110`). | The Home "Fix" button opens a page where nothing can be fixed. The lender is stuck, and the entry blocks their account deletion. |
| Request funded when confirmed money reaches the amount | WORKS | `src/app.js:913-920`, `:963-981` | Only confirmed amounts count; status flips to funded exactly at the principal. |
| Withdraw or close-early effect on a lender's "sent" entry | PARTIAL | Lender is emailed: `src/app.js:804-830,885-892`. Entry stays `sent` and blocks deletion: `:229-245`, `src/rules.js:300-309`. No Home item, no button (see Fix). | The email says "remove it in the app", but the app has nowhere to do it. |
| Receives repayments in instalments (borrower or trusted contact records to a lender) | WORKS | `src/app.js:1041-1075`, `src/rules.js:236-250`; `request.js:111-120` | Per-lender balances; any number of instalments; request becomes repaid at zero owed. |
| Confirms or marks repayment not received | WORKS | `src/app.js:1077-1107`; Home `confirm_repayment` `:602`; `request.js:107-110` | Confirm is one tap from Home. |
| Overdue loans: who sees "overdue" | BROKEN | `src/rules.js:291-294` and `src/app.js:1180-1196`, `:1221` apply `overdue` and `daysOverdue` for every viewer, including mutual connections who are not lenders. Spec section 2 anti-goal: "overdue status is never shown to the wider circle." | A borrower's late repayment is labelled in the feed of their whole circle: the shaming the product promises not to do. |
| Entry waiting 7+ days: "Waiting 7+ days" label, WhatsApp nudge, "Ask the owner" | MISSING | No code: `grep helpRequestedAt` hits only repo field maps. `request.js` WhatsApp text exists only for overdue repayments (`:124,138`). Spec 5.5a, P-34. | Lender has no in-context way to chase or escalate; only the generic Profile "Get help" form. |
| Owner queue: stuck entries listed, owner confirms or removes with note, cannot settle own | WORKS | `src/app.js:369-449`; `public/app/pages/admin.js:60-72` | The owner can unstick an entry correctly. |
| Settlement visible in timeline ("Settled by owner: note") and both sides emailed | MISSING | `contributionJson` (`src/app.js:831-834`) omits `settled*`; `adminSettle` sends no mail (`:400-425`, comment "No email in this phase"). Spec 5.5a. | After an owner settles, the lender sees the status change with no explanation. |
| Vote on a new due date (Phase C, P-28) | MISSING | No route; tables exist only in `supabase/migrations/0002_customer_ready.sql:94-111`. | Borrower cannot ask for more time; the lender cannot answer. |
| Receives thank-you note (Phase C, P-25) | MISSING | No route or table use; `notes` table only in migration `:122`. `profile.js:70` shows a thank-you email toggle that controls nothing. | Nothing; the toggle misleads. |
| Statement | WORKS | `src/app.js:198-227`; `public/app/pages/profile.js:177-232` | Lender sees lent, repaid, owed, UTRs. |
| Receipt per request (Phase C, P-25) | MISSING | No `/requests/:id/receipt`, no print page. | No per-loan proof to keep or share. |
| Trust history of the borrower visible | PARTIAL | API ok (mutual connections only): `src/app.js:476-484`, `src/rules.js:312-316`. UI renders it only on the member's own profile: `profile.js:35-63`; `request.js:129` shows only a name. | The lender cannot see the borrower's repayment record before sending money, which is the stated point of the history. |
| Emails (Phase C, P-11) | PARTIAL | Sent today: request decided, contribution to confirm, confirmed, not received, repayment to confirm, repayment confirmed or not received, withdrawn or closed (`src/app.js:793-800,953-961,976,985,1065,1090,1101,885-892`). Missing: due reminders, day-after, date proposed or decided, thank-you, settlement, verifier alert. No plain-text part, links go to `/app/` not the request (`:48`), no `EMAIL_ENABLED` gate (`src/services.js:40-44`; checklist section 4 accepts this until Phase C). | Core money emails work. Nobody is reminded; links make the lender hunt for the request. |
| Daily job: reminders at 7 and 1 day, day after, close lapsed open requests | MISSING | No `/cron/daily`, no cron in `vercel.json`, no `notifications_sent` use. | Open requests never close on their due date; no polite reminders (P-24, P-28, P-33). |
| Lender nudges borrower on WhatsApp to confirm | MISSING | `request.js` has no "please confirm you received" text. Spec section 7 WhatsApp. | A lender whose borrower is slow has no one-tap nudge. |
| Account deletion blocked while owed or while entries wait | WORKS | `src/app.js:229-250`, `src/rules.js:300-309`; journey tests 1, 3, 4 | The ledger cannot lose a creditor. Message explains why. |

Lender tally (25 rows): 12 WORKS, 3 PARTIAL, 7 MISSING, 3 BROKEN.

## Verifier journey

| Step | Status | Evidence | Impact on the person |
|---|---|---|---|
| Appointed by the owner; non-admins refused; owner cannot remove own role | WORKS | `src/app.js:302-311`; `public/app/pages/admin.js` members tab | Clear single control point (P-5, P-12). |
| Sees pending requests, even non-mutual, under Home "Needs you" | WORKS | `src/app.js:596-597,611-616`; `home.js:22` | Verifier finds work only by opening Home. |
| Opens the pending request | WORKS | `src/rules.js:270`, `src/app.js:671-684` | Sees purpose, amount, category, who decided. |
| Told a request is waiting | MISSING | No mail in `src/app.js:745-757` (contact accepts) or anywhere for verifiers; spec email list has none. | A verifier who does not open the app never knows; requests wait. |
| Approves | WORKS | `src/app.js:775-802`; `request.js:145-152` | One tap. |
| Rejects with a reason (10 to 500 characters) | PARTIAL | API ok: `src/rules.js:123-143`. UI label reads "Note (optional)" (`request.js:147`); a short reason only produces a toast (`:171-174`). | Verifier is told the note is optional, taps Reject and gets an error. |
| Cannot verify own request or as trusted contact; no Home item | WORKS | `src/rules.js:155-161`, `src/app.js:596,613-614` | Separation of roles holds. |
| Two approvals open; one rejection closes; one verifier counts once | WORKS | `src/rules.js:145-152`, `src/memory-repo.js:196-200` | Matches P-5. |
| Rejection reason private to the borrower, emailed | WORKS | `src/app.js:793-799,1230-1233` | Borrower learns why; others do not see it. |
| Fewer than two eligible verifiers: owner sees "Needs another verifier" | WORKS | `src/app.js:355-367`; `admin.js:78` | Owner can spot a stalled request. |
| Borrower sees "Waiting for the verification team" in that case | MISSING | Detail JSON has no such field (`src/app.js:1210-1252`); page says "Two approvals are needed" (`request.js:144`). Spec 5.7a. | Borrower waits with no explanation. |
| Removal of verifier role | PARTIAL | Works going forward (loses Home items, detail 404, 403 on verify): `src/app.js:302-311`. A removed member's earlier approval still counts toward the two: `src/rules.js:145-152` reads stored decisions only. | One ex-verifier plus one new verifier can open a request. |
| Verifier "Roles" list in My activity | PARTIAL | `src/app.js:631-669` lists every request the verifier voted on; visibility rule (`src/rules.js:270`) returns 404 once the request leaves verification. | Roles rows open "This request is not available to you". |

Verifier tally (13 rows): 8 WORKS, 3 PARTIAL, 2 MISSING, 0 BROKEN.

Combined (38 rows): 20 WORKS, 6 PARTIAL, 9 MISSING, 3 BROKEN.

## Ranked gaps

Each gap has a `todo` test in `test/journeys/lender-and-verifier.test.js` (title in quotes). Field names marked "proposed" are the audit's suggestion; the spec names the behaviour only.

### Must fix before launch

1. **Lenders cannot find requests (BROKEN).** Make the Requests tab render the circle feed (or add open requests of mutual connections to Home). Test: "lender can reach the circle feed from the app".
2. **"Fix" has nothing to fix (BROKEN).** Add edit-amount/UTR and remove buttons on the request page for `not_received` contributions and repayments, calling the existing PATCH and DELETE routes. Test: "lender can correct (PATCH) or remove (DELETE)...".
3. **Stale "sent" entries after withdraw or close are unreachable (PARTIAL).** Add a Home needs-you item (and the remove button from gap 2) for a lender's `sent` entry on a withdrawn or closed request. Test: "after withdraw or close, the lender sees a Home item".
4. **Overdue is shown to the whole circle (BROKEN, anti-goal).** In `summarise` and `detail`, return `funded` and `daysOverdue: 0` unless the viewer is the borrower, trusted contact or a lender on that request. Test: "only the people in a loan see overdue".

### Should fix

5. **Stuck entries: lender side (MISSING, P-34).** Add `POST /contributions/:id/help` and `POST /repayments/:id/help` (409 before 7 days, set `helpRequestedAt`, show on `/admin/stuck`), a `waitingDays` field, and the "Waiting 7+ days" label with WhatsApp nudge. Tests: "lender and borrower can ask the owner...", "the same ask-the-owner route exists for repayments", "an entry waiting 7+ days is flagged".
6. **Owner settlement is silent (MISSING).** Include `settledNote` and `settledByName` in entry JSON, show in the timeline, and email both sides. Test: "an owner settlement shows in the request timeline and emails both sides".
7. **WhatsApp "please confirm you received" nudge for the lender (MISSING).** Add the button and text on a `sent` entry. Test: "a lender can nudge the borrower on WhatsApp".
8. **Borrower trust history on the request page (PARTIAL).** Fetch `/users/:borrowerId` and render the trust list for mutual connections. Test: "a lender sees the borrower's trust history".
9. **Reject form says "optional" (PARTIAL).** Relabel to "Reason (10 to 500 characters)", validate in the page, raise the limit mismatch (textarea `maxlength=1000` vs 500). Test: "the reject form asks for a reason".
10. **Borrower not told verification is stalled (MISSING).** Return `waitingForVerificationTeam` (proposed) when fewer than two eligible verifiers exist, and show the spec text. Test: "the borrower sees Waiting for the verification team".
11. **Removed verifier's approval still counts (PARTIAL).** Count only decisions by members who are currently verifiers. Test: "an approval from a member who is no longer a verifier does not count".
12. **Email quality (PARTIAL).** Add a plain-text part and a deep link `#/request/<id>` to every email, and an `EMAIL_ENABLED` gate defaulting off. Tests: "every email carries a plain-text part and a link", "production email sending sits behind EMAIL_ENABLED".
13. **Verifier alert (MISSING).** Email eligible verifiers when a request reaches `pending_verification`. Test: "verifiers are told by email".

### Later (Phase C features, no code today)

14. **New due date vote (MISSING).** `POST /requests/:id/date-changes` and `POST /date-changes/:id/vote` with the 6-month, one-pending, three-proposal rules; email lenders. Tests: "the borrower proposes a new due date...", "one declined vote ends the proposal".
15. **Thank-you notes (MISSING).** `POST /requests/:id/notes`, show on detail, email lenders unless `emailThanks` is off. Test: "the borrower posts a thank-you note".
16. **Receipt (MISSING).** `GET /requests/:id/receipt` (borrower, contact, lenders) plus a print page. Test: "a lender gets a printable receipt".
17. **Daily job (MISSING).** `GET /cron/daily` with `Bearer CRON_SECRET`, exempt from sign-in, reminders at 7 and 1 day before and the day after, close or withdraw lapsed open requests, idempotent via `notifications_sent`; add the cron entry to `vercel.json`. Tests: "the daily job emails due reminders...", "an open request that reaches its due date closes...".
18. **Roles list dead ends (PARTIAL).** Either let a verifier who decided read the request, or drop dead links from the Roles list. Test: "every request listed under a verifier's Roles can be opened".

### Notes outside the gap list

- `public/app/pages/profile.js:70-77` offers reminder and thank-you toggles and says "Emails when a repayment date changes: Always on". None of those emails exist yet; hide the text until Phase C ships.
- `GET /feed` and `GET /home` run one or three queries per request. Fine at pilot size (5 to 6 people); revisit before wide launch.
- `package.json` already globs `test/journeys/*.test.js`; no change made.
