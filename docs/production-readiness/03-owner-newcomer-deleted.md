# Production readiness 03: owner/admin, invited newcomer, deleted member, signed-out visitor

Branch `claude/gifted-thompson-e3onnq` at `24dfd1c`. Spec authority: `docs/superpowers/specs/2026-11-23-customer-ready-design.md`, `docs/15-product-decisions.md`, `docs/release/phase-a-production-checklist.md`.
Evidence is the code as read, plus `test/journeys/owner-newcomer-deleted.test.js` (34 tests: 7 pass today and cover what WORKS; 27 are `todo` gap tests that each fail today and carry the assertions the fix must meet).

Status words: WORKS (does what the spec says), PARTIAL (works with a visible hole), MISSING (spec or operator need, no code), BROKEN (code exists and does the wrong thing).

Phase C status in one line: no cron route, no `crons` in `vercel.json`, no `CRON_SECRET` or `EMAIL_ENABLED` anywhere in `src/` (grep clean); only transactional emails exist (invite, trusted-contact request, approve/reject, "sent" to confirm, confirmed/not received, repayment, withdrawn/closed). No reminders, overdue, date-change, thank-you, owner-help or account emails. Trust history (`GET /users/:id` trust) and the statement exist; receipts, date changes and thank-you notes do not (no routes).

## Journey 1: owner / admin

| # | Step | Status | Evidence | Impact |
|---|---|---|---|---|
| O1 | First sign-in with `OWNER_EMAIL` becomes admin + verifier, case-insensitive, no invite needed | WORKS | `src/app.js:53,91-95,111-117` | Pilot can start |
| O2 | Owner whose Clerk email is unverified | PARTIAL | `app.js:53` needs a verified email, so the owner falls through to the generic 403 `invite_only` at `:97`; `email_unverified` is only reachable with an invite | Owner at go-live is told "invite only", not "verify your email" |
| O3 | Every admin route refuses non-admins (403) and anonymous (401) | WORKS | `app.js:153-156`, routes `:269-449` | No privilege leak |
| O4 | Admin Members tab: list, verifier toggle, per-member invite limit 0-50, cannot demote self | WORKS | `app.js:297-324`, `admin.js` members view | Owner can build the verification team |
| O5 | Make or remove another admin, change `OWNER_EMAIL` owner | MISSING | no route sets `isAdmin`; only the env email path `app.js:93`; old owner stays admin forever | Succession and lost-account recovery need Supabase SQL |
| O6 | Invites tab: all invites, state, revoke, "joined with a different email" badge | WORKS | `app.js:327-341`, `admin.js` invites view | Forwarded links are visible (P-35) |
| O7 | Invite first members: email, one-time link, WhatsApp `wa.me` link, remaining allowance | WORKS | `app.js:512-538`, `circle.js` invite form | Core pilot step works |
| O8 | Link lost or WhatsApp not sent | PARTIAL | link shown once (`circle.js` invite card); no resend or re-show; revoke frees the allowance (`memory-repo.js:158`, `supabase-repo.js:208-213`) | Workable: revoke and re-create; owner must know the invitee's email |
| O9 | Invite email to the invitee | PARTIAL | `app.js:529` `safeMail` runs whenever `RESEND_API_KEY` is set (`services.js:38-44`); spec says sending is behind `EMAIL_ENABLED`, default off, owner-only switch | Real mail can go to real people the moment the key is set |
| O10 | Help messages: members write, owner lists with sender email, resolves | WORKS | `app.js:253-282`, `admin.js` help view | Support channel exists |
| O11 | Owner is emailed on a help message (P-42) | MISSING | `app.js:253-258` only stores; comment says "nothing here sends email" | Owner must open the Help tab to discover messages |
| O12 | Stuck entries (7 IST days): list, confirm or remove with note, cannot settle own payment | WORKS | `app.js:374-449` | Pilot disputes can be closed |
| O13 | Settlement emails both sides (spec 5.5a) | MISSING | `app.js:402` "No email in this phase"; test 3 | Members learn of the owner's decision only by opening the app |
| O14 | Member "Ask the owner" on a stuck entry and "Waiting 7+ days" nudge (P-34) | MISSING | no `/contributions/:id/help` or `/repayments/:id/help` route; `request.js:138` only has the overdue WhatsApp text | Owner finds stuck items only by visiting the Stuck tab |
| O15 | Verification gaps tab (fewer than 2 eligible verifiers) | WORKS | `app.js:355-368`, `admin.js` gaps view | Detects the pilot's first trap: owner is the only verifier, so the first request can never open |
| O16 | Borrower is told "Waiting for the verification team" (5.7a) | MISSING | no such copy in `public/` | Borrower sees "Awaiting verification" forever and writes to support |
| O17 | Monitoring during the pilot: stats | PARTIAL | `app.js:343-351` gives 3 numbers; no request list, overdue overview, money totals, member activity, no pagination on members/invites | Owner cannot see pilot health without SQL |
| O18 | Audit log of admin actions | MISSING | only `settled_by/note/at` on entries (`0002`, `0004`); verifier toggles, limit changes, invite revokes unrecorded | No answer to "who made X a verifier" |
| O19 | Export of data | MISSING | no route or script (only `scripts/make-verifier.js`) | Cannot hand a member or regulator their data, no off-platform copy |
| O20 | Suspend or remove a member | MISSING | no route; account state changes only by the member's own delete | A bad actor cannot be locked out from the app |
| O21 | Last admin guard on delete | BROKEN | `app.js:229-250` has no guard; `deleteAccount` sets `isAdmin:false` (`memory-repo.js:96-100`, `0005_delete_account_fn.sql:20`) | Owner can delete themselves and orphan the admin page; the same email would re-create a blank admin with no history |
| O22 | Operator needs: cron, `EMAIL_ENABLED`, reminders (Phase C) | MISSING | no code (see top); tests 9-11 | Reminders and overdue emails advertised on the landing cannot happen |
| O23 | Operator needs: backups, restore drill, incident runbook, error alerting | MISSING | not in the release checklist or docs (grep for backup/incident/alert is empty); errors only `logger.error` | A bad migration or deleted row has no documented recovery |
| O24 | `.env.example` for the operator | BROKEN | `.env.example` lacks `OWNER_EMAIL`, `CRON_SECRET`, `EMAIL_ENABLED` and still lists `INTEREST_RATE_ANNUAL=0.12` (removed by spec 5.4) | Operator who follows it cannot sign in as owner |

## Journey 2: invited newcomer

| # | Step | Status | Evidence | Impact |
|---|---|---|---|---|
| N1 | WhatsApp link `/app/#join=<token>` is kept through sign-in | WORKS | `public/app.js:8-12` (sessionStorage), `:31-33` sent as `x-invite-token` | Survives the Google redirect in the same tab |
| N2 | Signed-out screen after tapping the link | PARTIAL | `public/app/index.html:26-30` generic "Sign in to continue"; nothing says the invite was picked up | Newcomer may doubt it is the right link |
| N3 | Sign in with Google or email code, verified email required | WORKS | `services.js:19-21` trusts only verified Clerk email; `app.js:99-102` returns `email_unverified` and does not burn the invite | Safe |
| N4 | `email_unverified` shown to the person | PARTIAL | `public/app.js:250` handles only `invite_only`; other errors become a 3.5 s toast | Rare (Clerk verifies on sign-up) but a dead end if hit |
| N5 | Admission by token: single use, 14-day expiry, revoked, superseded, any email (P-35), or by verified-email invite | WORKS | `app.js:49-66,105-108`, `invites.js:22-29`; tests 13-14 | Rules match the spec |
| N6 | Dead link wording | PARTIAL | `app.js:17-20`: expired, revoked, used and never-invited all return the same `invite_only` | A 15-day-old link reads as "not allowed"; no "ask for a new link" |
| N7 | Not invited: dead-end screen | PARTIAL | `index.html:43-46` one sentence; no link to the landing page, no sign-out hint (spec 8.11) | Visitor stuck on a blank page, only the Clerk avatar can sign out |
| N8 | Welcome: name, UPI (optional, validated), terms checkbox, rules | WORKS | `welcome.js:25-128`, `app.js:166-186,451-461` | Matches P-32 |
| N9 | Terms accepted before acting, server side | PARTIAL | only `needsWelcome` in `public/app.js:160-168`; the API lets any member act without terms (test 16) | Agreement can be skipped by anyone calling the API; thin legal record |
| N10 | Connected to inviter both ways immediately; inviter name shown | WORKS | `app.js:69-73,158-164`, `welcome.js:68-74` | Newcomer sees a circle at once |
| N11 | Welcome step 2 "invite one more person" | PARTIAL | text only, no form or link (`welcome.js:75-83`) | Growth nudge does nothing |
| N12 | First request: inviter is already a valid trusted contact | WORKS | `app.js:711-737`, test 13; empty Home offers Start a request and Invite (`home.js`) | First action is reachable on a phone |
| N13 | First loan | PARTIAL | possible only when a mutual connection has an open request; for a newcomer that needs the inviter to have one, and verification needs 2 other verifiers (O15, O16) | New member may see "Nothing here yet" for days |
| N14 | Same-device but different-tab sign-in (email link opened elsewhere) loses the token | PARTIAL | token lives only in tab `sessionStorage` (`public/app.js:10`); email-matched invite rescues it (`app.js:59-62`) | Mismatched-email newcomers get "invite only" |

## Journey 3: deleted member

| # | Step | Status | Evidence | Impact |
|---|---|---|---|---|
| D1 | Typed `DELETE` confirmation | WORKS | `app.js:230`, `profile.js:94-98,160-170` | No accidental delete |
| D2 | Blocked by active request, trusted-contact duty, money owed to them, unsettled payments, with plain explanations | WORKS | `app.js:229-246`, `rules.js:300-306`; test 21 | Ledger cannot be orphaned |
| D3 | Deletion is atomic and anonymises | WORKS | `supabase-repo.js:155-159`, `0005_delete_account_fn.sql` (name "Former member", placeholder email, `deleted:<id>` clerk id, UPI/avatar cleared, flags off, follows and own open invites removed) | Privacy promise met for profile data |
| D4 | Anonymised in others' records, never listed | WORKS | `GET /users/:id` returns "Former member", no email/UPI; `/connections`, `/users?q`, admin members exclude (`app.js:463-510`, `supabase-repo.js:127,148`); test 21 | Others see no personal data |
| D5 | What others still see | WORKS | request, confirmed money and repayments stay visible to borrower/lender via `/requests/:id` and `/activity`; the deleted person's requests drop from mutuals' feeds (follows removed) | Both sides keep an accurate history, as the privacy page says |
| D6 | Cannot sign back in | WORKS | `app.js:84-97` the old Clerk id no longer matches (`deleted:<id>`); with no invite the answer is 403 `invite_only` | Old login is useless |
| D7 | Clerk login removal | PARTIAL | `app.js:248` calls `deleteClerkUser`; failure only logged, response is `{ok:true}` (test 23) | Member told "deleted" while their email stays in Clerk; nobody retries |
| D8 | Email freed for a future invite | WORKS | placeholder email, invite emails updated (`0005:24`); test 21 re-invites | Re-joining is possible as a new member |
| D9 | Free-text the member wrote | BROKEN | `0005_delete_account_fn.sql` never touches `help_messages`; body (often a phone number) stays in the admin Help tab under "Former member" (test 24) | Contradicts "we remove your name, email and UPI" scope; personal data survives |
| D10 | Confirmation email of deletion (P-40 account events) | MISSING | `app.js:229-250` sends nothing | No receipt for a destructive action |
| D11 | Deleting a verifier | WORKS | `listUsers` excludes deleted, so the Gaps tab shows the shortfall (test 26) | Owner is not blind to it |
| D12 | Deleting the only admin | BROKEN | see O21 | Owner lock-out risk |

## Journey 4: signed-out visitor

| # | Step | Status | Evidence | Impact |
|---|---|---|---|---|
| V1 | Claims vs product: rupees with Indian grouping, ₹50,000, 12 months, no interest, "does not move money", "trusted contact", invite only in FAQ | WORKS | `public/index.html` (hero, steps, FAQ), `test/landing-copy.test.js`; test 27 | Honest on money, interest, record-only |
| V2 | Claim: trusted contact "gets the due-date reminders" and is "kept informed of the due date" | BROKEN | `index.html` FAQ and example card; no reminder job exists (O22; test 32) | Landing promises something the product does not do |
| V3 | Hero call to action "Start a request" says nothing about invitation | PARTIAL | `index.html` hero `<a href="/app/#new">`; invite-only appears only in the FAQ (spec 8 wanted a line near the CTA; test 30) | Stranger taps, signs in, lands on Not invited |
| V4 | Terms and Privacy reachable from the landing page | MISSING | footer has "App" and "Questions" only; text exists only as hash routes in the app (`legal.js`, `public/app.js:149-155`); no `/terms` or `/privacy` URL, no rewrite in `vercel.json` (tests 28-29) | Visitor and Clerk sign-in collect data with no policy link; launch blocker |
| V5 | Terms and Privacy content | PARTIAL | `legal.js` plain English, marked "not yet reviewed by a lawyer" (P-36 says lawyer review before wide launch); privacy page omits Clerk, Supabase, Resend and Vercel as processors and has no grievance contact | Draft is honest but incomplete for India |
| V6 | SEO | WORKS | title, description, canonical, OG/Twitter with real `og-image.png`, valid JSON-LD, `robots.txt` (disallow `/app/`), sitemap, app is `noindex`; test 27 | Findable and shareable on WhatsApp |
| V7 | SEO gaps | PARTIAL | sitemap lists only `/`; no `<link rel="icon">` anywhere, so `/favicon.ico` 404s (test 33) | Minor |
| V8 | Install (P-31) | PARTIAL | manifest valid, icons present, service worker registered from `/app/` (`app/index.html:9,98-100`); landing has no manifest link or "Add it to your home screen" FAQ (test 31) | Installable but undiscoverable |
| V9 | Analytics (P-43) | MISSING | no Vercel Web Analytics tag on landing; owner decision, switch is the owner's | Pilot cannot see landing traffic (owner-only action) |
| V10 | README states interest and nominees | BROKEN | `README.md` intro: "interest starts after the due date", "a nominee stands behind the repayment" (test 34) | Anyone reading the repo sees the opposite of P-3 and P-6 |

## Gap list, ranked

### Must fix before launch
1. **V4 Terms and Privacy not reachable from landing.** Add footer links and static `/terms` and `/privacy` pages (or `vercel.json` rewrites to a hash route). Tests 28, 29.
2. **V2 Landing promises reminders that do not exist.** Either build the Phase C cron (O22) or remove the reminder wording from the FAQ and example card. Test 32.
3. **O22 / O9 No `EMAIL_ENABLED` gate.** Read `EMAIL_ENABLED` in `services.js` (default off) so setting `RESEND_API_KEY` alone cannot email real people (standing restriction). Test 10.
4. **O24 `.env.example` and runbook.** Add `OWNER_EMAIL`, `CRON_SECRET`, `EMAIL_ENABLED`; delete `INTEREST_RATE_ANNUAL`. Test 12.
5. **O21 / D12 Last-admin guard.** Return 409 from `DELETE /me` when the caller is the only admin. Test 7.
6. **D9 Help-message text survives deletion.** Delete or blank `help_messages` for the member inside `delete_member_account`. Test 24.
7. **O16 Borrower told about the verifier shortage.** Show "Waiting for the verification team" when eligible verifiers < required (needed on day one: the owner is the only verifier). Test 8.
8. **O23 Backup, restore and incident basics.** Document Supabase backup plan, one restore drill and an incident checklist in the release docs. No test (process item).
9. **N9 Terms enforced server side.** Reject member actions (403 `terms_required`) until `termsAcceptedAt` is set. Test 16.

### Should fix
1. **O11 Owner email on help messages (P-42)**: send to `OWNER_EMAIL` after `POST /help`. Test 2.
2. **O13 Settlement emails (5.5a)**: mail payer and receiver in `adminSettle`. Test 3.
3. **O14 Stuck-entry "Ask the owner" and 7+ day nudge**: add `POST /contributions/:id/help` and `/repayments/:id/help`. No test (route shape not fixed by spec beyond the path).
4. **O18 Audit log**: new `admin_audit` table written by every admin route, with `GET /admin/audit-log`. Test 4.
5. **O19 Export**: `GET /admin/export` (members, requests, entries as JSON/CSV). Test 5.
6. **O20 Suspend member**: `POST /admin/members/:id/suspend` that `requireUser` honours. Test 6.
7. **N6 Distinct dead-link codes**: return `invite_expired`, `invite_revoked`, `invite_used` and say "ask for a new link". Test 15.
8. **N7 / N2 / N4 Not-invited and signed-out screens**: link to `/`, sign-out button, "You've been invited" line, handle `email_unverified`. Tests 17, 18, 19.
9. **D7 Clerk removal visibility**: return `clerkRemoved:false` and keep a retry list for the owner. Test 23.
10. **D10 Account-deleted email** (P-40). Test 25.
11. **V3 / V8 Landing CTA and install**: invite-only line beside the hero CTA, "Add it to your home screen" FAQ. Tests 30, 31.
12. **O17 Pilot monitoring**: add counts of requests by status, overdue, money confirmed, and pagination to admin lists.
13. **O5 Admin succession**: let an admin promote or demote admins.
14. **V5 Privacy notice**: name Clerk, Supabase, Resend, Vercel and a contact address; lawyer review (P-36).
15. **O22 Phase C**: cron daily job, `CRON_SECRET`, reminders, date changes, thank-you notes, receipts. Tests 9, 11.

### Later
1. **N11 Welcome step 2 invite shortcut.** Link to Circle. Test 20.
2. **N13 First-loan emptiness for newcomers**: suggest the inviter's open request, or explain none are open.
3. **N14 Token in `localStorage` fallback** for cross-tab email sign-in (the email-matched invite already covers most cases).
4. **O2 Owner with unverified email**: show `email_unverified` instead of invite-only.
5. **O8 Re-show a lost invite link** (store nothing new; just allow re-create without allowance cost, which already works).
6. **V7 Favicon and sitemap entries.** Test 33.
7. **V10 README rewrite** to match the shipped product. Test 34.
8. **V9 Vercel Web Analytics** (owner switches it on).
