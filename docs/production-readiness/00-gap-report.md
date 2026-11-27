# Production readiness 00: consolidated gap report

Branch `claude/gifted-thompson-e3onnq` at `24dfd1c`. Built from reports 01 to 04 and the 72 `todo` tests in `test/journeys/`. Nothing here is new research: every gap comes from a source report or a todo test, and duplicates are merged. Audit date 2026-11-27.

Test file short names: **BC** = `test/journeys/borrower-and-contact.test.js`, **LV** = `test/journeys/lender-and-verifier.test.js`, **ON** = `test/journeys/owner-newcomer-deleted.test.js`. Titles are shortened; each is a prefix of the real test title.

## 1. Summary

Step ratings per journey (from reports 01 to 03). WORKS = per spec, PARTIAL = works with a hole, MISSING = not built, BROKEN = built but the person hits a dead end or wrong result.

| Journey | Steps | WORKS | PARTIAL | MISSING | BROKEN | Todo tests |
|---|---|---|---|---|---|---|
| Borrower | 29 | 15 | 6 | 7 | 1 | 22 (shared with Trusted contact) |
| Trusted contact | 11 | 6 | 3 | 2 | 0 | (in the 22 above) |
| Lender | 25 | 12 | 3 | 7 | 3 | 23 (shared with Verifier) |
| Verifier | 13 | 8 | 3 | 2 | 0 | (in the 23 above) |
| Owner / admin | 24 | 8 | 4 | 10 | 2 | 11 |
| Invited newcomer | 14 | 6 | 8 | 0 | 0 | 6 |
| Deleted member | 12 | 8 | 1 | 1 | 2 | 3 |
| Signed-out visitor | 10 | 2 | 4 | 2 | 2 | 7 |
| **Total** | **138** | **65** | **32** | **31** | **12** | **72** |

Todo tests by file: BC 22, LV 23, ON 27 = 72. Every one is assigned to a gap below (section 2 lists them).

Unique gaps after de-duplication: **50** (18 Must fix before launch, 24 Should fix, 8 Later). Gap G-01 and G-15, G-40 to G-42, G-50 have no todo test (process or merge items from the reports).

One line of context: the money rules (cap, two-step confirmation, instalments, mutual-only, deletion block, owner settlement) are sound at the API. The launch problems are (a) finished APIs with no buttons, (b) nothing time-based, (c) two diverged branches, (d) a few trust and privacy holes.

## 2. De-duplicated gap list

Fields: **Affects** user types. **Type** = UI only, API, data/migration, infrastructure, owner decision. **Merge** = depends on the branch merge in report 04 (Hard = build after it, Soft = works either way but touches files the other branch also changes, No = independent).

### Must fix before launch

**G-01 Two diverged branches must become one base.** Affects: everyone (all releases). Severity: Must. Type: data/migration + owner decision. Tests: none (report 04). Fix: merge `security/production-readiness-2026-11` into ours on a new branch, keep both feature sets, renumber our migrations `0004_removed_entry_status` and `0005_delete_account_fn` to 0009 and 0010, add 0011 so audit events credit the owner on settle, remove the duplicate `GET /admin/members`. Merge: this is the merge (5 textual conflicts plus silent ones: duplicate admin route, duplicate migration numbers, `listUsers` signature).

**G-02 Request page has no withdraw, close early, pick another contact, or Try again.** Affects: borrower. Severity: Must. Type: UI only (APIs exist: `/withdraw`, `/close`, `/trusted-contact`). Tests: BC "request page lets the borrower withdraw while it is withdrawable"; BC "...'Close with Rs X' on a part-funded open request"; BC "...pick another trusted contact after a decline"; BC "a rejected request offers 'Try again' with the form prefilled". Fix: add the buttons and a contact picker to `request.js`, and a prefilled Try again link into `new-request.js`. Merge: Soft (`request.js` also changed by their Idempotency-Key work; it auto-merged in the trial).

**G-03 "Fix" is a dead end: lender cannot correct or remove a not-received entry.** Affects: lender, borrower (blocked deletion). Severity: Must (BROKEN in 01 and 02). Type: UI only (PATCH/DELETE exist). Tests: BC "a lender can correct or remove an entry the borrower marked not received"; LV "lender can correct (PATCH) or remove (DELETE) an entry...". Fix: edit and delete controls in the contribution and repayment rows of `request.js`. Merge: Soft; if the UTR rule from their branch is kept (decision 2) the edit form must ask for a UTR.

**G-04 Stale "sent" entries after withdraw or close are unreachable and block account deletion.** Affects: lender, borrower. Severity: Must. Type: API + UI. Tests: BC "closing or withdrawing voids leftover 'sent' entries..."; LV "after withdraw or close, the lender sees a Home item to remove their stale 'sent' entry". Fix: add a Home needs-you item with the remove button from G-03 for a lender's `sent` entry on a withdrawn or closed request. The two tests assert different fixes (void automatically vs lender removes); voiding silently hides money a lender may really have sent, so recommended default is the lender-removes path, and BC's test should be re-aimed to match. Merge: Soft.

**G-05 Overdue status is shown to the whole circle (contradicts the anti-shaming goal).** Affects: borrower, every mutual connection. Severity: Must. Type: API. Tests: LV "only the people in a loan see 'overdue'; other mutual connections see the plain funded status". Fix: in `summarise` and `detail`, return plain `funded` and `daysOverdue: 0` unless the viewer is borrower, trusted contact or a lender on that request. Merge: Soft (`src/app.js` auto-merged but needs review).

**G-06 Lenders cannot find a connection's open request from the app.** Affects: lender (the core lend step). Severity: Must (BROKEN). Type: UI only. Tests: LV "lender can reach the circle feed from the app...". Fix: give `#/feed` an entry point (Requests tab or Home list). Their branch adds a Discover tab on `#/feed`, which may close this gap. Merge: Hard (`nav.js` is a conflicted file; decision 3 chooses the tabs).

**G-07 No daily job: open requests never close at the due date and still take money.** Affects: borrower, lender, trusted contact. Severity: Must. Type: infrastructure + API. Tests: BC "an open request past its due date refuses new contributions"; BC "daily cron closes part-funded requests, withdraws unfunded ones and sends reminders"; LV "an open request that reaches its due date closes at the confirmed amount, or is withdrawn..."; ON "daily cron is wired in vercel.json and guarded by CRON_SECRET". Fix: `GET /cron/daily` with `Bearer CRON_SECRET` (exempt from sign-in), a `crons` entry in `vercel.json`, a due-date check in `rules.checkContribution`, and close or withdraw lapsed open requests. The tables needed already exist in migration 0002. Merge: Soft (`src/app.js`, `vercel.json`).

**G-08 No `EMAIL_ENABLED` switch: setting `RESEND_API_KEY` alone emails real people.** Affects: owner, everyone emailed. Severity: Must (standing owner-only rule, spec section 7). Type: infrastructure. Tests: BC "email sending is behind an EMAIL_ENABLED switch that defaults to off"; LV "production email sending sits behind EMAIL_ENABLED, default off, and logs without addresses"; ON "email sending is behind EMAIL_ENABLED, default off (Phase C)". Fix: read `EMAIL_ENABLED` (default off) in `services.js`; log only the mail kind, not subject or address. Merge: No.

**G-09 Trusted contact never answers: borrower can re-pick only after a decline.** Affects: borrower. Severity: Must. Type: API (+ the picker from G-02). Tests: BC "trusted contact never answers for 7 days: borrower may pick someone else". Fix: allow `/trusted-contact` from `awaiting_contact` once the request or last pick is 7 or more days old. Merge: Soft.

**G-10 Trusted contact loses the request on Home after accepting.** Affects: trusted contact. Severity: Must. Type: API. Tests: BC "an accepted request shows up for the trusted contact on Home". Fix: include requests where the member is the trusted contact in `GET /home`. Merge: Soft.

**G-11 Borrower is not told when verification is stalled.** Affects: borrower, owner. Severity: Must (on day one the owner is the only verifier, so the first request cannot open). Type: API + UI. Tests: BC "borrower sees 'Waiting for the verification team'..."; LV "the borrower sees 'Waiting for the verification team'... (proposed field waitingForVerificationTeam)"; ON "owner: a requested verification gap is visible to the borrower (spec 5.7a)". Fix: return `waitingForVerificationTeam` (proposed name) when fewer than two eligible verifiers exist and show the spec 5.7a text. Merge: Soft.

**G-12 Terms and Privacy are not reachable from the landing page.** Affects: signed-out visitor, newcomer. Severity: Must (launch blocker in 03). Type: UI only + static pages. Tests: ON "visitor: the landing footer links to Terms and Privacy"; ON "visitor: /terms and /privacy are real static pages". Fix: footer links plus static `/terms` and `/privacy` (or `vercel.json` rewrites to the hash routes). Merge: No.

**G-13 Copy promises features that do not exist.** Affects: visitor, trusted contact, all members. Severity: Must. Type: UI only (copy). Tests: ON "visitor: landing promises only what exists: trusted-contact reminders need the Phase C cron". Fix: remove the "get the due-date reminders" wording from the FAQ and example card (or ship G-21), and hide the profile reminder and thank-you toggles and "Always on" line at `profile.js:70-77` until they do something. Merge: No.

**G-14 `.env.example` is wrong for the operator.** Affects: owner (operator). Severity: Must (BROKEN: following it, the owner cannot sign in). Type: infrastructure (docs). Tests: ON "owner: .env.example documents the pilot variables and drops the removed interest rate". Fix: add `OWNER_EMAIL`, `CRON_SECRET`, `EMAIL_ENABLED`; delete `INTEREST_RATE_ANNUAL`. Merge: Soft (their branch already removes the interest variable; keep the union).

**G-15 No backup, restore or incident plan.** Affects: owner. Severity: Must. Type: infrastructure (process docs). Tests: none. Fix: document the Supabase backup plan, run one restore drill, and add a short incident checklist to `docs/release/`. Merge: No.

**G-16 The only admin can delete their own account.** Affects: owner, deleted member. Severity: Must (BROKEN). Type: API. Tests: ON "owner: the only admin cannot delete their own account". Fix: return 409 from `DELETE /me` when the caller is the only admin. Merge: Hard-ish (their role RPC already guards role changes, not deletion; reuse its admin count).

**G-17 A deleted member's help-message text survives.** Affects: deleted member. Severity: Must (BROKEN; contradicts the privacy page). Type: data/migration. Tests: ON "deleted: free-text help messages are removed or redacted with the account (P-36)". Fix: blank or delete the member's `help_messages` inside `delete_member_account`. Merge: Hard (that function becomes migration 0010; add the change as a new migration after 0011).

**G-18 Terms acceptance is enforced only by the web app.** Affects: newcomer, all members. Severity: Must (thin legal record). Type: API. Tests: ON "newcomer: the server requires accepted terms before a member can act (P-36)". Fix: reject member actions with 403 `terms_required` until `termsAcceptedAt` is set. Risk: many existing tests act without accepting terms. Merge: Soft.

### Should fix

**G-19 Reject form says the note is optional.** Affects: verifier, borrower. Type: UI only. Tests: BC "rejecting needs a visible reason field (10 to 500 characters)..."; LV "the reject form asks for a reason (10 to 500 characters)...". Fix: label "Reason (10 to 500 characters)", validate on the page, `maxlength` 500 (now 1000). Merge: No.

**G-20 Borrower is not emailed when the contact accepts or declines.** Affects: borrower. Type: API. Tests: BC "borrower is emailed when the trusted contact accepts or declines". Fix: send mail in `contact-decision` (gated by G-08). Merge: No.

**G-21 No reminder emails (7 days and 1 day before, day after due).** Affects: borrower, trusted contact, lender. Type: API + infrastructure. Tests: LV "the daily job emails due reminders (7 and 1 day before, day after) once a day..."; ON "owner: reminder, overdue and thank-you emails exist (Phase C)". Fix: add reminder mails to the G-07 job with `notifications_sent` dedupe (table exists in 0002). Merge: Soft.

**G-22 Emails are html only and link to `/app/`, not the request.** Affects: all emailed. Type: API. Tests: LV "every email carries a plain-text part and a link to the request". Fix: add a text part and a `#/request/<id>` link to every mail. Merge: No.

**G-23 Verifiers are not told when a request starts waiting.** Affects: verifier. Type: API. Tests: LV "verifiers are told by email when a request starts waiting for them". Fix: email eligible verifiers on `pending_verification` (gated by G-08). Merge: No.

**G-24 A removed verifier's earlier approval still counts.** Affects: verifier, borrower, owner. Type: API. Tests: LV "an approval from a member who is no longer a verifier does not count toward the two". Fix: count only decisions by current verifiers in `verificationOutcome`. Merge: Soft (their role RPC is the only role writer).

**G-25 Stuck entries: no "Ask the owner" and no "Waiting 7+ days" label.** Affects: lender, borrower, trusted contact, owner. Type: API + UI. Tests: BC "a stuck contribution can be sent to the owner with 'Ask the owner to help'"; BC "entries waiting 7+ days show a 'Waiting 7+ days' label with a WhatsApp nudge"; LV "lender and borrower can ask the owner for help on an entry stuck 7+ days"; LV "the same ask-the-owner route exists for repayments"; LV "an entry waiting 7+ days is flagged to its lender in the request detail (proposed field waitingDays)". Fix: `POST /contributions/:id/help` and `/repayments/:id/help` (409 before 7 days, set `helpRequestedAt`), a `waitingDays` field, the label and a WhatsApp nudge. Merge: Soft.

**G-26 Owner settlement is silent.** Affects: lender, borrower, owner. Type: API + data/migration. Tests: LV "an owner settlement shows in the request timeline and emails both sides"; ON "owner: settling a stuck entry emails both sides (spec 5.5a)". Fix: include `settledNote` and `settledByName` in entry JSON, show in the timeline, email both sides in `adminSettle`. Merge: Hard (the 0011 audit attribution fix goes with it).

**G-27 WhatsApp nudges missing for lenders.** Affects: lender. Type: UI only. Tests: BC "lenders get the WhatsApp reminder button on an overdue request, not only borrower and contact"; LV "a lender can nudge the borrower on WhatsApp to confirm". Fix: show the overdue button to lenders and add a "please confirm you received" text on a `sent` entry. Merge: No.

**G-28 Lender cannot see the borrower's trust history before lending.** Affects: lender. Type: UI only (API returns it for mutual connections). Tests: LV "a lender sees the borrower's trust history...". Fix: fetch `/users/:borrowerId` and render the list on the request page. Merge: No.

**G-29 A contact who declined keeps a slot and cannot delete their account.** Affects: trusted contact. Type: API. Tests: BC "a contact who declined can delete their account without waiting for the borrower". Fix: count only `awaiting_contact` in `countActiveAsContact`. Merge: No.

**G-30 Contact picker copy contradicts the terms.** Affects: borrower, trusted contact. Type: UI only (copy; legal exposure). Tests: BC "trusted-contact picker copy matches the terms: a contact is not a guarantor". Fix: replace "They help repay if you cannot" at `new-request.js:49` to match `legal.js`. Merge: No.

**G-31 Owner is not emailed on help messages (P-42).** Affects: owner. Type: API. Tests: ON "owner: a help message emails the owner (P-42)". Fix: mail `OWNER_EMAIL` after `POST /help` (gated by G-08). Merge: No.

**G-32 No audit log of admin actions.** Affects: owner. Type: data/migration + API. Tests: ON "owner: admin actions leave an audit log the owner can read". Fix: `admin_audit` writes on every admin route plus `GET /admin/audit-log`. Their branch adds `GET /admin/audit-events` and audited role changes, which may cover most of this; invite revokes and limit changes still need recording. Merge: Hard (likely mostly solved by it).

**G-33 No export of ledger and members.** Affects: owner. Type: API. Tests: ON "owner: the owner can export the ledger and members (CSV/JSON)". Fix: `GET /admin/export`. Merge: No.

**G-34 No way to suspend a member.** Affects: owner. Type: API. Tests: ON "owner: the owner can suspend a member who must be locked out". Fix: `POST /admin/members/:id/suspend` honoured by `requireUser`. Merge: Soft.

**G-35 Dead invite links all read "invite only".** Affects: newcomer. Type: API + UI. Tests: ON "newcomer: an expired, revoked or used link says so...". Fix: distinct codes `invite_expired`, `invite_revoked`, `invite_used` with "ask for a new link". Merge: No.

**G-36 Signed-out, not-invited and unverified-email screens are thin.** Affects: newcomer, visitor. Type: UI only. Tests: ON "newcomer: the not-invited screen links back to the landing page and offers sign-out"; ON "newcomer: the signed-out /app screen acknowledges an invite link"; ON "newcomer: the unverified-email refusal is explained on screen". Fix: link to `/`, sign-out button, "You've been invited" line, handle `email_unverified` on screen. Merge: Soft (`public/app.js`).

**G-37 Clerk account removal can fail unseen.** Affects: deleted member, owner. Type: API. Tests: ON "deleted: the response says when the sign-in account could not be removed". Fix: return `clerkRemoved:false` and keep a retry list for the owner. Merge: No.

**G-38 No confirmation email on account deletion (P-40).** Affects: deleted member. Type: API. Tests: ON "deleted: the person is told by email that the account was deleted (P-40 account events)". Fix: send the mail before the Clerk delete (gated by G-08). Merge: No.

**G-39 Landing CTA does not mention invitation; no install hint.** Affects: visitor. Type: UI only (copy). Tests: ON "visitor: the hero explains that joining is by invitation next to the call to action"; ON "visitor: the FAQ explains adding the app to the home screen". Fix: one invite-only line beside the hero CTA and an "Add it to your home screen" FAQ entry. Merge: No.

**G-40 Privacy notice incomplete; no lawyer review (P-36).** Affects: all members. Type: owner decision. Tests: none. Fix: name Clerk, Supabase, Resend, Vercel and a contact address on the privacy page; lawyer review before wide launch. Merge: No.

**G-41 Pilot monitoring is thin.** Affects: owner. Type: API + UI. Tests: none. Fix: add request counts by status, overdue count and confirmed money to `/admin/stats`, and pagination to admin lists. Merge: Soft (their `GET /admin/operations` may overlap).

**G-42 No admin succession.** Affects: owner. Type: API. Tests: none. Fix: let an admin promote or demote admins. Their audited `PATCH /admin/members/:id/roles` does this. Merge: Hard (closed by the merge).

### Later

**G-43 Due-date proposals and lender votes (P-28).** Affects: borrower, lender. Type: API + UI. Tests: BC "borrower can propose a new due date on a funded or overdue request"; LV "the borrower proposes a new due date and each lender who is owed money votes"; LV "one declined vote ends the proposal and the due date stays". Fix: `POST /requests/:id/date-changes` and `POST /date-changes/:id/vote` (tables exist in 0002). Reports differ: 01 ranks it Should, 02 Later; put Later as no money rule depends on it (decision 6). Merge: No.

**G-44 Thank-you notes (P-25).** Affects: borrower, lender. Type: API + UI. Tests: BC "borrower can post a thank-you note once a contribution is confirmed"; LV "the borrower posts a thank-you note; lenders are emailed unless they switched thank-yous off". Fix: `POST /requests/:id/notes`, show on detail, email unless `emailThanks` is off. Merge: No.

**G-45 Per-request receipt (P-25).** Affects: borrower, lender, trusted contact. Type: API + UI. Tests: BC "a receipt is available to the borrower, trusted contact and lenders"; LV "a lender gets a printable receipt for a request; outsiders get 404". Fix: `GET /requests/:id/receipt` plus a print page. Merge: No.

**G-46 Verifier Roles list opens "not available".** Affects: verifier. Type: API or UI. Tests: LV "every request listed under a verifier's Roles in My activity can be opened by them". Fix: let a verifier who decided read the request, or drop the dead rows. Merge: No.

**G-47 Welcome step 2 "invite one more person" does nothing.** Affects: newcomer. Type: UI only. Tests: ON "newcomer: a newcomer can invite a second person from the welcome step". Fix: link to Circle's invite form. Merge: No.

**G-48 No favicon.** Affects: visitor. Type: UI only. Tests: ON "visitor: the landing page has a favicon". Fix: `<link rel="icon">` on landing and app. Merge: No.

**G-49 README still describes interest and nominees.** Affects: anyone reading the repo. Type: UI only (docs). Tests: ON "visitor: the README no longer describes interest and nominees". Fix: rewrite the intro to match P-3 and P-6. Merge: Soft (their branch already rewrites README interest wording).

**G-50 Minor polish without tests.** Affects: newcomer, owner, contact. Type: UI/API. Tests: none. Items: first-loan empty state for newcomers (N13), invite token fallback across tabs (N14), owner with unverified email sees "invite only" (O2), hide contacts already at 3 requests in the picker, Vercel Web Analytics (owner switch, V9). Merge: No.

## 3. Build order for "Must fix before launch"

Each package is one test-first task: remove `todo` from the listed tests, watch them fail, then fix. Order puts decisions and cheap, merge-independent work first, then the merge, then API work that touches `src/app.js` and migrations. If the owner is slow to answer decisions 1 to 3, packages WP-1 to WP-3 can proceed on the current branch.

| Order | Package | Gaps | Files likely touched | Size |
|---|---|---|---|---|
| 1 | **WP-1 Operator switches and docs** | G-08, G-14, G-15 | `src/services.js`, `.env.example`, `docs/release/` (new backup and incident notes) | S |
| 2 | **WP-2 Landing and legal** | G-12, G-13 | `public/index.html`, new `public/terms/` and `public/privacy/` (or `vercel.json` rewrites), `public/app/pages/profile.js`, `public/app/pages/legal.js` | S |
| 3 | **WP-3 Request-page wiring (UI only)** | G-02, G-03 | `public/app/pages/request.js`, `public/app/pages/new-request.js`, `public/app/pages/home.js` | M |
| 4 | **WP-4 Branch merge** (needs decisions 1 to 3) | G-01, G-06 | `public/app.js`, `public/app/nav.js`, `src/memory-repo.js`, `src/supabase-repo.js`, `src/app.js` (admin routes), `supabase/migrations/` (renumber, add 0011), `test/api-phase-b.test.js`, `docs/release/phase-a-production-checklist.md`, `public/sw.js` (bump cache) | L |
| 5 | **WP-5 Request-state API fixes** | G-04, G-05, G-09, G-10, G-11 | `src/app.js`, `src/rules.js`, `src/memory-repo.js`, `public/app/pages/request.js`, `public/app/pages/home.js` | M |
| 6 | **WP-6 Daily job and due-date enforcement** | G-07 | `src/app.js` (route, sign-in exemption), `src/rules.js` (`checkContribution`), repos (due-request query), `vercel.json` | M |
| 7 | **WP-7 Account and access integrity** | G-16, G-17, G-18 | `src/app.js` (`DELETE /me`, member guard), new migration after 0011 for `delete_member_account`, `public/app.js` | M |

Why this order: WP-1 and WP-2 are small and carry the standing "no real email" rule and the launch-blocking legal links. WP-3 is the cheap wiring of existing APIs and changes only files that did not conflict in the trial merge. The merge comes before anything that edits `src/app.js`, `nav.js` or migrations, so those do not get resolved twice. WP-5 relies on the G-03 remove button for G-04. WP-6 needs the merged `app.js`. WP-7 last because the terms gate (G-18) can break many existing tests and the migration number depends on the merge.

Suggested Should-fix packages after launch blockers (not detailed): emails (G-20 to G-23, G-31, G-38, after G-08); stuck entries (G-25, G-26, G-27); small UI (G-19, G-28, G-30, G-36, G-39); verifier trust (G-24); admin tooling (G-32 to G-34, G-41).

## 4. Owner decisions needed

Each has options and a recommended default. These merge the owner questions of all four reports.

1. **Which branch is the base, and where does the merged work land?** (04 Q3) Options: (a) merge theirs into ours on a new branch, then open a PR to the security branch (draft PR #1) or to `main`; (b) merge ours into theirs. Default: (a), on a new branch off ours, no deploy until you approve (P-4).
2. **Is a UTR required when marking "sent"?** (04 Q1; P-22 says optional, their branch requires it and makes it unique per request, migration 0008.) Options: required and unique; optional but unique when given. Default: optional but unique when given, because P-22 is the written decision and cash or other channels would otherwise be unrecordable. If you choose required, update P-22.
3. **Member tabs.** (04 Q2) Options: our five (Home, Requests, New, Circle, Profile); their six (adds Discover, Requests renamed Activity); five that include the feed. Default: no more than five at 320 px (44 px touch rule), with the feed reachable as a tab; this also closes G-06.
4. **May the last admin delete their own account?** (04 Q4, 03 O21) Options: block with 409; allow after naming another admin. Default: block until another admin exists (their role RPC can promote one).
5. **Verifier count at launch.** (03 O15, 02) The owner is the only verifier today, so no request can open. Options: keep two approvals and appoint a second verifier before day one; lower to one approval for the pilot. Default: keep two (P-5) and appoint a second verifier before any request is made; ship G-11 so the borrower sees why it waits.
6. **Phase C scope for launch.** (01, 02, 03) Reminders, due-date votes, thank-you notes, receipts have no code. Options: ship auto-close only and soften the copy; ship reminders too; ship all. Default: ship G-07 (auto-close) and fix the copy (G-13); build reminders (G-21) only if emails go on; defer votes, notes, receipts (G-43 to G-45).
7. **Emails on or off for the pilot?** (EMAIL_ENABLED, standing owner-only rule) Options: off (in-app Home items only); on after the sending domain is verified. Default: off in code; you switch it on after a staging test.
8. **Clerk settings.** (03: N3, O2, D7, V4) Confirm: verified email required, Google and email-code sign-in on, production instance keys in use, a Terms and Privacy link on the sign-in screen, and the deletion call allowed to remove users. Default: confirm each in the Clerk dashboard before launch (nothing here can check it).
9. **Unpause staging and apply migrations?** (04 Q7) Options: unpause, apply 0009 to 0011 and the new WP-7 migration to staging only, run the integration suite; or wait. Default: yes, staging only, once you add the GitHub `staging` secrets and the Vercel Preview key.
10. **Backups.** (03 O23) Which Supabase plan and backup schedule? Default: confirm daily backups exist and run one restore drill into a scratch project before launch.
11. **Privacy and lawyer review.** (03 V5, P-36) Options: lawyer review before the pilot; review before wide launch. Default: add the processors and a contact address now (G-40), review before wide launch.
12. **Admin tools needed at launch: audit, export, suspend.** (03 O18 to O20) Default: take the audit from the merge, produce exports on request from SQL, defer suspend.
13. **Verification immutability.** (04 Q6) Preserve the first decision and correction history. Default: after launch.
14. **Idempotency retention.** (04 Q5) `financial_idempotency` rows are never deleted. Default: 30 days with a retention job later.
15. **Vercel daily deployment limit.** (04 Q8) The free-plan limit blocked the last Preview build. Options: paid plan; space out deployments. Default: space out deployments; a paid plan is your cost decision.
16. **Production landing copy.** (04 Q9) The live landing still shows interest, USD and nominee wording. Default: ship the new copy together with this release, not before.
17. **Web Analytics.** (03 V9, P-43) Owner-only switch. Default: leave off for the pilot.

## 5. What cannot be verified in this sandbox

Everything above was checked by reading code and running the in-memory journey tests (`test/helpers/harness`). Real services were not reachable.

| Area | Not verified | How to verify later |
|---|---|---|
| Supabase (live) | Migrations applied in order 0001 to 0011, RLS, `record_*` and `delete_member_account` RPCs on real Postgres, concurrency, advisor warnings, migration 0008 duplicate-UTR check, backups and restore | Staging project: apply migrations in order, run `test/integration/supabase.integration.test.js`, run the advisors, do the restore drill (decision 10) |
| Clerk | Verified-email rule, Google redirect keeping the invite token, `deleteClerkUser` failures, production keys and sign-in screen links | Sign in with a fresh Google account and an email-code account on staging using a real WhatsApp invite link; delete a test account and check Clerk |
| Resend | Domain verification, delivery, spam placement, plain-text part, `EMAIL_ENABLED` behaviour | Verify the domain, enable on staging only, send each mail kind to owner-owned inboxes |
| UPI apps and QR | Deep links and amounts in PhonePe, Google Pay, Paytm; QR scans | Test on real Android and iPhone with a Rs 100 request |
| WhatsApp | `wa.me` invite and reminder links on real phones | Tap each link on a phone |
| Vercel | Cron firing with `CRON_SECRET`, `/terms` and `/privacy` rewrites, Preview build limit, Analytics | Deploy a Preview, call `/cron/daily` with and without the secret, open both legal URLs |
| Browser and phone layout | Visual baselines (375, 768, 1440), 320 px tab bar, service-worker cache after merge | Regenerate baselines in a real browser and review; load the app on a phone after the cache version bump |
| Merged test suite | `npm test` on the merged tree has not been run (trial merge had conflict markers) | Run the full suite after resolving the five conflicts |
