# Production readiness 01: borrower and trusted-contact journeys

Branch `claude/gifted-thompson-e3onnq` at `24dfd1c`. Authority: `docs/superpowers/specs/2026-11-23-customer-ready-design.md`, `docs/15-product-decisions.md`, `docs/release/phase-a-production-checklist.md`.
Method: every step walked through `src/app.js`, `src/rules.js`, the memory repo, `public/app/pages/*.js` and `public/app.js`, then exercised through the API in `test/journeys/borrower-and-contact.test.js` (7 passing journey tests, 22 `todo` gap tests that currently fail).

Rating key: WORKS = behaves per spec end to end. PARTIAL = works but a piece is missing or wrong. MISSING = not built. BROKEN = built, but a real user hits a dead end or wrong result.

## Headline

- The API for Phase A and B is solid: limits, one active request, two-step confirmation, per-lender instalments, trust history, statement, deletion rules all hold in tests.
- The request page (`public/app/pages/request.js`) does not expose four finished API actions: withdraw, close early, pick another trusted contact, and fix or remove a "not received" entry. A borrower whose contact declines or never answers is stuck with an active request they cannot end, and so cannot start another.
- Nothing time-based exists: no cron route, no auto-close at the due date, no reminders, no overdue emails. A request left `open` past its due date still accepts contributions.
- Phase C: transactional emails exist (partly); due-date proposals, thank-you notes, receipts, per-entry "ask the owner", the cron and the `EMAIL_ENABLED` switch are not built (no code at all).

## Journey 1: Borrower

| # | Step | Rating | Evidence | Impact on the user |
|---|---|---|---|---|
| B1 | Invited by email, link valid 14 days, one use | WORKS | `src/app.js:512-538`, `src/app.js:44-60`, `src/invites.js:25-32` | Person gets a WhatsApp or email link; token stored hashed. |
| B2 | Joins and is connected to the inviter at once | WORKS | `src/app.js:63-77` | Inviter can be named trusted contact straight away. |
| B3 | Welcome: name, UPI ID, terms checkbox, rules | WORKS | `public/app/pages/welcome.js:30-125`, `src/app.js:451-461` | Under two minutes on a phone; terms agreement is recorded. |
| B4 | Connect circle (follow, mutual, invite more) | WORKS | `public/app/pages/circle.js:266-360`, `src/app.js:486-556` | Mutual connections feed the contact picker. |
| B5 | Create request: Rs 100 to Rs 50,000, within 12 months, category, purpose 20+ chars | WORKS | `src/rules.js:56-103`, `src/app.js:711-738`, `public/app/pages/new-request.js:137-170` | Bad input gets a field-level message; edges (Rs 100, Rs 50,000, exactly 12 months) accepted. |
| B6 | One active request at a time | WORKS | `src/rules.js:105-110`, `src/app.js:713-714`, `new-request.js:170-177` | Clear "you already have an active request" page. |
| B7 | Contact declines, borrower picks someone else | PARTIAL | API `src/app.js:759-774`; no page calls `/trusted-contact` (`grep` of `public/`); Home links to the request via `home.js:19` but `request.js` has no picker | Home says "Choose another trusted contact" and the page offers nothing. Borrower is stuck. |
| B8 | Contact gives no answer for 7 days, borrower prompted to re-pick | MISSING | `src/app.js:763` allows re-pick only from `contact_declined`; no timer anywhere | Request sits at "Waiting for trusted contact" for ever; only withdraw (API) can end it. |
| B9 | Verification: two approvals open it | WORKS | `src/app.js:775-802`, `src/rules.js:145-152` | Borrower emailed when approved (`src/app.js:793-799`). |
| B10 | Rejection with reason (10 to 500 chars, borrower only) | PARTIAL | API `src/rules.js:123-141`, `src/app.js:781-796`; verifier form says "Note (optional)", maxlength 1000 (`request.js:147`); reason shown as bare red text (`request.js:133`) | Rejecting with no reason gives a confusing API error toast. Borrower sees the reason but no next step. |
| B11 | "Try again": new request prefilled, contact asked again | MISSING | API lets a new request start at once (`rules.js:8`, rejected is not active); no button or prefill in `request.js` / `new-request.js` | Borrower must retype everything and may not know they can. |
| B12 | Open: lenders send, borrower confirms or marks not received | WORKS | `src/app.js:928-993`, `request.js:103-106`, home needs list `src/app.js:588-597` | Both-sides confirmation holds; cap and race guard tested. |
| B13 | Lender corrects or removes a "not received" entry | BROKEN | API `src/app.js:995-1031` works; `home.js:19` shows a "Fix" button but `request.js:103-110` renders no edit or delete control | Lender is sent to a page where they cannot fix anything. |
| B14 | Close early at the confirmed amount | PARTIAL | API `src/app.js:818-828`; no control in `request.js` | A part-funded borrower cannot close from the app. |
| B15 | Auto-close at due date (open, part-funded -> funded; unfunded -> withdrawn) | MISSING | No cron (`grep cron src/ vercel.json` empty); `rules.checkContribution` (`rules.js:188`) has no date check | Open request past due still takes money; part-funded request never becomes repayable unless borrower closes it. |
| B16 | Leftover "sent" entries after close or withdraw | PARTIAL | `src/app.js:818-828`, `src/app.js:244-246` | Stale `sent` rows count as unsettled and block the borrower's account deletion until the lender removes them (no UI for that, see B13). |
| B17 | Funded: repay each lender in instalments by UPI deep link or QR | WORKS | `src/app.js:1041-1075`, `rules.js:236-250`, `request.js:20-54,111-120` | Over-paying a lender refused; pay button on phone, QR on desktop. |
| B18 | Overdue: "Overdue" label, days overdue, repay still allowed | WORKS | `rules.js:291-294`, `src/app.js:1048`, `request.js:131` | Never shown to the wider circle (feed filters, `src/app.js:558-571`). |
| B19 | Overdue reminders by email (7 d, 1 d, day after) | MISSING | No cron, no `notifications_sent`, no reminder mail in `src/` | Nobody nags politely; the app's main promise is unmet. |
| B20 | WhatsApp reminder button | PARTIAL | `request.js:124,138` only for borrower and contact on overdue; lenders (the people who need to nudge) get none | Lender must write their own message. |
| B21 | Propose a new due date; lenders vote | MISSING | No `/date-changes` route, no table use (`grep date-change src/`) | No gentle path when late (P-28); borrower can only stay overdue. |
| B22 | Repaid: all lenders cleared, banner | WORKS | `src/app.js:921-926`, `request.js:132` | Status flips only when every lender is confirmed clear. |
| B23 | Thank-you notes to lenders | MISSING | No `/notes` route | Nothing marigold or warm at the happy ending. |
| B24 | Receipt per request | MISSING | No `/receipt` route or page | Lender or borrower cannot print proof of one loan. |
| B25 | Statement across all requests and loans | WORKS | `src/app.js:198-227`, `profile.js:177-230` | Print or save as PDF, share summary; UTR shown only to the right people. |
| B26 | Trust history (facts only) | WORKS | `src/rules.js:312-316`, `src/app.js:1170-1178`, `profile.js:35-42` | On-time uses the due date; "final agreed date" cannot differ until B21 exists. |
| B27 | Withdraw | PARTIAL | API `src/app.js:804-816` (sends email to lenders with `sent` entries); no control in `request.js` | Combined with B7/B8, a borrower cannot get out of a stuck request. |
| B28 | Help form | WORKS | `src/app.js:253-267`, `profile.js:80-91` | Message reaches the admin page. Per-entry "Ask the owner to help" (P-34) is MISSING (`/contributions/:id/help` 404). |
| B29 | Delete account | WORKS | `src/app.js:229-251`, `rules.js:300-308`, `profile.js:92-100,160-172` | Blocked with a plain reason while active, owed, or unsettled; name becomes "Former member". |

## Journey 2: Trusted contact

| # | Step | Rating | Evidence | Impact on the user |
|---|---|---|---|---|
| T1 | Notified when named | WORKS | Email `src/app.js:699-710,736`; Home item `src/app.js:595`, `home.js:21` | Contact gets email and a "Decide" card. |
| T2 | Accept or decline | WORKS | `src/app.js:745-757`, `request.js:139-142` | Request moves to verification or `contact_declined`; answers once only. |
| T3 | View the request | WORKS | `src/app.js:670-685`, `rules.js:265-272` | Contact can read it in every status. |
| T4 | Borrower told of the answer | MISSING | `src/app.js:745-757` sends no mail | Borrower waits without knowing. |
| T5 | Find the request again later | PARTIAL | Home lists only borrowed or lent requests (`src/app.js:574-630`); Requests tab lists it under Roles (`app.js:96-125`) | After accepting, the card disappears from Home. |
| T6 | Reminders to the contact (7 d, 1 d, day after due) | MISSING | No cron | Contact is never nudged to help the borrower repay. |
| T7 | Record repayment on borrower's behalf | WORKS | `src/app.js:1041-1075`, `card-model.js:416`, `request.js:98` | Lender confirms; both borrower and contact are emailed (`src/app.js:1092`). |
| T8 | Max 3 active requests | WORKS | `rules.js:113-122`, `src/app.js:687-697` | Picker does not hide full contacts; the 409 message appears on submit. |
| T9 | Deletion blocked while active | WORKS | `src/app.js:244-246`, `rules.js:300-303` | Clear reason; freed on repaid. |
| T10 | Declined request frees the decliner | PARTIAL | `countActiveAsContact` counts `contact_declined` (`memory-repo.js:192`, ACTIVE list `rules.js:8`) | A contact who said no still holds one of 3 slots and cannot delete their account until the borrower acts. |
| T11 | Role copy is consistent | PARTIAL | `new-request.js:49` "They help repay if you cannot" vs `legal.js:17` "no obligation to repay" | Contradictory promise; legal exposure. |

## Phase C items (spec sections 5.5, 5.5a, 5.9, 5.10, 7) and whether code exists

| Item | Code today | Evidence |
|---|---|---|
| Transactional emails | PARTIAL: contact named, approved/rejected, contribution to confirm, confirmed, not received, repayment to confirm/confirmed/not received, withdrawn/closed, invite | `src/app.js:699-1090`. Missing: contact accepted/declined, due reminders, overdue, date proposal/decision, thank-you. Mails carry no plain-text part and link only to `/app/` not the request (`app.js:41-45`, `services.js:42`). |
| `EMAIL_ENABLED` switch (default off) | None | Only `RESEND_API_KEY` gates sending (`src/services.js:38-44`); contradicts spec section 7. |
| Cron `GET /cron/daily`, `CRON_SECRET`, Vercel cron | None | no `cron` in `src/`; `vercel.json` has no `crons`. |
| Reminders and `notifications_sent` dedupe | None | no table use in `src/`. |
| Auto-close at due date | None (manual close exists, `src/app.js:818`) | see B15. |
| Due-date proposals and lender votes | None | no routes; `original_repayment_date` column exists only in repo field lists (`memory-repo.js:18`). |
| Thank-you notes | None | no route. |
| Receipts | None (statement exists) | no route or page. |
| Stuck entries: "Waiting 7+ days", nudge, ask the owner | Admin side only (`src/app.js:374-448`); no member UI, no `/contributions/:id/help` | `request.js` has no such text. |
| WhatsApp texts | PARTIAL: invite, overdue reminder, ask for UPI ID | `circle.js:347`, `request.js:44,124`. No "please confirm" or "I've repaid" texts. |

## Gap list, ranked

### Must fix before launch

1. **Request page lacks withdraw, close early and re-pick contact; no "Try again".** A declined or silent contact leaves the borrower stuck behind the one-active rule. Fix: add buttons on `request.js` for `/withdraw`, `/close`, `/trusted-contact` (contact picker) and a prefilled "Try again" on rejected requests. (tests: 4 todo)
2. **"Fix" dead end: lender cannot correct or remove a not-received entry.** Fix: edit and delete controls in `contributionRow` and `repaymentRow` calling the existing PATCH and DELETE. (BROKEN)
3. **No time-based engine.** No auto-close, no reminders, open requests past due still take money. Fix: add `GET /cron/daily` guarded by `CRON_SECRET`, a `crons` entry in `vercel.json`, a due-date check in `checkContribution`, and `notifications_sent` dedupe.
4. **7-day no-answer from the trusted contact.** Fix: allow `/trusted-contact` re-pick from `awaiting_contact` once `createdAt` (or last re-pick) is 7+ days old.
5. **Borrower is not told when the contact answers, and the contact loses the request on Home.** Fix: mail the borrower in `contact-decision`; include contact requests in `GET /home`.
6. **No `EMAIL_ENABLED` gate.** Any deploy with `RESEND_API_KEY` sends real mail, against the standing owner-only rule. Fix: default-off flag checked in the mailer.

### Should fix

7. Stale `sent` entries after close or withdraw block account deletion; void them on close and withdraw (or let the borrower clear them).
8. A declining contact keeps a slot and cannot delete their account; count only `awaiting_contact` for them.
9. Reject form: label "Reason (required, 10 to 500 characters)" and set maxlength 500.
10. Fix the "They help repay if you cannot" hint in `new-request.js:49` to match the terms.
11. Lender-side WhatsApp reminder on overdue requests and the confirm/repaid WhatsApp texts (P-24).
12. Due-date proposals and lender votes (P-28): `POST /requests/:id/date-changes`, `POST /date-changes/:id/vote`, request-page UI.
13. Thank-you notes, receipt route and page (P-25).
14. "Waiting 7+ days" label with WhatsApp nudge and `POST /contributions/:id/help` (P-34).
15. Emails: add a plain-text part and a deep link to the request.

### Later

16. Borrower-side "Waiting for the verification team" text when fewer than two verifiers (spec 5.7a).
17. Mail-skipped log line includes the subject (names and amounts); log only the kind.
18. Trusted-contact picker could hide contacts already at 3 requests.
19. Welcome step 2 could link straight to "Invite someone".

## Tests

`node --test test/journeys/borrower-and-contact.test.js`: 7 passing journeys (borrower full path, rejection and retry, decline/re-pick/withdraw/limit edges, close early and overdue, help and deletion, contact path, contact max 3) and 22 `todo` gap tests (all currently fail, as intended; BROKEN B13 is a todo that fails). The file is added to the `npm test` glob.
