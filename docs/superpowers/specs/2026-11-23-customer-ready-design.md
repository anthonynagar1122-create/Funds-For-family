# Funds For Family: customer-ready design

Date: 2026-11-23. Status: draft for owner approval.
Builds on `docs/15-product-decisions.md` (P-1 to P-20). Where this document and older docs (01–14) differ, this one and doc 15 win.

## 1. Intent

Families and friends in India already lend each other small amounts. It goes wrong in quiet ways: nobody remembers exactly who sent what, the borrower feels awkward asking, and the lender feels awkward reminding. Funds For Family is a calm, shared record that makes that easier and keeps it friendly:

- the purpose is checked by a small trusted team before anyone lends;
- every rupee is confirmed by both sides (sent, then received);
- paying is one tap with UPI, but the app never holds money;
- reminders are polite and come from the app, so nobody has to nag;
- people who repay well build a visible, factual history in their circle.

The owner wants it ready for real customers, not only a pilot. They should be able to find it easy, trust it, and invite the people they already lend to.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A new member can go from WhatsApp invite to their first request or loan in under five minutes on a phone.
2. Both sides always agree on the numbers: only confirmed amounts count.
3. Members invite their own circles, and the owner can see whether invites turn into active members.
4. Repaying feels supported (reminders, instalments, a gentle path when late), never punished.

**Non-goals (this version)**
- Holding, moving or settling money; any payment gateway; any payment licence (P-1).
- Interest, fees or penalties (P-6). The app is free (owner decision, 2026-11-23).
- Credit scores, public profiles, search for strangers, an open waitlist.
- Native apps, SMS, automatic WhatsApp messages (WhatsApp Business API), phone-number sign-in.
- Languages other than English (P-15), but all text lives in one strings module.

**Anti-goals: failures even if the app works**
- Anything that makes it feel like a lending business or a debt collector.
- Shaming: overdue status is never shown to the wider circle.
- Showing a member's UPI ID or email to anyone except the people they share a request with.
- Counting money that one side has not confirmed.

## 3. Owner decisions from 2026-11-23 (added to doc 15)

| # | Area | Decision |
|---|---|---|
| P-21 | First customers | Not targeted. Any member invites whoever they like; the landing page speaks to families and friends in general. |
| P-22 | Paying | UPI deep link and QR code with the amount filled in. The payer can enter the UPI reference (UTR) when marking "sent". Still record-only. |
| P-23 | Sign-in | Google and email code through Clerk. No phone OTP. |
| P-24 | Reminders | Automatic email, plus "Remind on WhatsApp" buttons that open WhatsApp with a ready message the member sends themselves. |
| P-25 | Features | Trust history on profiles, repaying in instalments, receipts and statements, thank-you notes. |
| P-26 | Invites | The member enters the email, then shares a one-time link on WhatsApp. Each member has a monthly invite allowance the owner controls. |
| P-27 | Pricing | Free. |
| P-28 | Late repayment | Gentle steps: "Overdue" label, an email the day after to the borrower and trusted contact, and the borrower may propose a new date that each lender accepts or declines. No penalties, nothing shown publicly. |
| P-29 | Look | Calm Ledger green, plus one warm marigold accent for friendly moments. |
| P-30 | Mobile navigation | Bottom tab bar on phones, top bar on desktop. |
| P-31 | Install | Installable from the browser (web app manifest and service worker). |
| P-32 | First visit | A three-step welcome: name and UPI ID, connection with the inviter, the rules. |
| P-33 | Part-funded | The borrower can close a part-funded request at the confirmed amount. If they don't, it closes automatically on its due date at whatever was confirmed. |
| P-34 | Stuck entries | After 7 days without an answer, an item shows "Waiting 7+ days" with a WhatsApp nudge. Either side can ask the owner, who can confirm or remove the entry from the admin page. A note and the owner's name are recorded in the history. No automatic confirmation. |
| P-35 | Invite email | The one-time link is enough, whatever email the person signs in with. |
| P-36 | Privacy basics | Plain-English Terms and Privacy pages; agreement at the welcome step; the trusted contact must accept being named before verification; self-service account deletion (the name becomes "Former member" in others' records). The owner should have a lawyer review the pages before wide launch. |

## 4. Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **A. Extend the current app**: Express API on Vercel, plain HTML/JS pages, Supabase reached only from the server | Keeps 161 tests, the Clerk proxy, the Vercel setup and the RLS lockdown. Pages stay hand-written. | **Chosen** (agent's call; the owner handed over the how) |
| B. Rewrite the front end in Next.js/React | Nicer component model, but throws away working tests and deployment for no customer benefit, and delays the pilot. | Rejected |
| C. The browser queries Supabase directly with RLS policies | Less server code, but reopens the Data API that is deliberately closed, and every rule must be duplicated in SQL policies. | Rejected |

## 5. Money and rules (Phase A, built first)

All amounts are integers in paise. The existing `*_cents` columns keep their names and now mean "paise". This avoids a destructive rename. A comment in the migration says so. Display uses Indian grouping: `₹1,00,000.00`, through one `formatInr(paise)` function shared by server and browser.

### 5.1 Requests
- Amount: from ₹100 up to ₹50,000 (10,000 to 5,000,000 paise), whole rupees or paise.
- Purpose: 20 to 2,000 characters (unchanged).
- Due date: after today and no later than 12 calendar months from today (P-16).
- Trusted contact: required. Must be a mutual connection of the borrower and not the borrower. Stored in the existing `nominee_id` column. Code and UI say "trusted contact".
- One open request per member. A member cannot create a request while one of theirs is `pending_verification`, `open` or `funded` (overdue included). This is enforced in rules and by a partial unique index.
- Withdraw (agent's call): the borrower can withdraw a request while it is `pending_verification` or `open` and no contribution is `confirmed`. Its status becomes `withdrawn`. Any lender with a contribution still `sent` is told by email.
- Trusted contact consent (P-36): a new request starts as `awaiting_contact`. The trusted contact gets an email and a home-screen item, and accepts or declines. Accepting moves the request to `pending_verification`. Declining sets it to `contact_declined`, and the borrower may pick someone else, which starts a new consent. After 7 days with no answer, the borrower is prompted to pick someone else.
- Close early (P-33): while `open` with at least one confirmed contribution, the borrower can "Close with ₹X". `principal_cents` stays as asked, `funded_cents` is set to the confirmed total, and the status becomes `funded`. Any remaining `sent` contributions are told by email and can be removed by their lender. The daily job does the same automatically on the due date. An `open` request with nothing confirmed on its due date becomes `withdrawn`.
- Statuses: `awaiting_contact`, `contact_declined`, `pending_verification`, `rejected`, `open`, `funded`, `repaid`, `withdrawn`. "Overdue" is derived (funded and today in IST is after the due date). Repayments, new due dates and reminders apply only to `funded` requests. Thank-you notes are allowed on `open`, `funded` and `repaid`.
- Dates (agent's call): "today" is the calendar date in India Standard Time (Asia/Kolkata) everywhere.

### 5.2 Verification (unchanged, P-5)
Two distinct approvals open a request; one rejection closes it. A verifier cannot decide on a request where they are the borrower or the trusted contact.

### 5.3 Contributions: two-step (P-9, P-22)
1. A lender on an `open` request records "sent", with an amount and an optional UPI reference (UTR, 6 to 35 letters or digits). The status is `sent`.
2. The borrower marks it `confirmed` ("received") or `not_received`. With `not_received`, the lender can correct it (amount or UTR) and it goes back to `sent`, or delete it.
- Cap: the sum of `sent` plus `confirmed` amounts (not `not_received`) must not exceed the principal, so nobody over-sends.
- Only `confirmed` amounts count toward funded. When they reach the principal, the request becomes `funded`, `funded_at` is set and `funded_cents` equals the principal.
- Who can lend: a mutual connection of the borrower who is not the borrower. The trusted contact may lend.

### 5.4 Repayments: per lender, in instalments (P-10, P-25)
- Owed to a lender = their confirmed contributions minus their confirmed repayments.
- The borrower or the trusted contact records a repayment to a specific lender (amount and optional UTR). The status is `sent`. The lender marks it `confirmed` or `not_received`, with the same correct-or-delete path as contributions.
- Cap: `sent` plus `confirmed` repayments to a lender cannot exceed what that lender confirmed lending.
- Any number of instalments. A request becomes `repaid` (with `repaid_at` set) when every lender is owed zero in confirmed terms.
- Amount due on a request = confirmed contributions minus confirmed repayments. No interest. `interestCents`, `amountDueCents` with a rate, and `INTEREST_RATE_ANNUAL` are removed.

### 5.5 New due date (P-28)
- A borrower with a `funded` request (overdue or not) may propose a new date. It must be after today and no more than 6 months after the original due date (agent's call). Only one proposal can be pending at a time.
- Every lender who is still owed money accepts or declines. When all have accepted, `repayment_date` changes and the original date is kept in `original_repayment_date`. One decline ends the proposal. The borrower can propose again, at most 3 proposals per request (agent's call).

### 5.5a Stuck entries (P-34)
- Any `sent` or `not_received` contribution or repayment untouched for 7 days shows "Waiting 7+ days" to both sides, with a WhatsApp nudge button and an "Ask the owner to help" button. That button records a help request, which appears on the admin page.
- The admin can mark an entry `confirmed` or remove it. Both need a note (5 to 500 characters). The entry records `settled_by` (admin id), `settled_note` and `settled_at`, and the request timeline shows "Settled by <owner name>: <note>". Both sides get an email.
- An admin cannot settle an entry where they are the payer or the receiver (separation of roles).

### 5.6 Visibility (P-7)
- Mutual connection: both follow each other.
- The feed shows a member's own requests (any status) plus requests from mutual connections with status `open`, `funded` or `repaid`.
- The request detail is visible to the borrower, the trusted contact, its lenders, verifiers while it awaits verification, and mutual connections of the borrower while it is open, funded or repaid.
- A UPI ID is shown only inside a request where it is needed to pay: the borrower's to its lenders, and a lender's to the borrower and trusted contact. An email address is shown only to its owner (and the admin page).

### 5.7 Joining: invite only (P-8, P-26)
- A member creates an invite for an email address. The server stores only a SHA-256 hash of a random 32-byte token. The link `https://funds-for-family.vercel.app/app/#join=<token>` is shown once, with a "Share on WhatsApp" button (`https://wa.me/?text=...`) and a "Copy link" button.
- An invite expires after 14 days, is single use, and can be revoked by the inviter or the admin.
- Allowance: 5 invites per member per calendar month by default (`INVITES_PER_MONTH`), and the admin can set a different limit per member.
- First sign-in: if the Clerk user has no member row, the server needs either a valid, unexpired, unrevoked, unused token from the link, whatever the Clerk email (P-35), or an unexpired, unrevoked invite for the Clerk primary email (case-insensitive). The admin page shows the invited email next to the email the person actually joined with, so a forwarded link is visible. Otherwise it answers 403, and the page says "Funds For Family is invite only. Ask someone who uses it to send you an invite." The owner bootstraps through `OWNER_EMAIL`, which may sign up without an invite and becomes admin.
- Accepting an invite makes the inviter and the new member follow each other (a mutual connection) at once (agent's call: they already chose each other).
- Several invites for the same person (agent's call): the invite that is used wins and its inviter becomes the connection. Other open invites to the same email are closed as `superseded`, the new member gets a "follow back" suggestion for those inviters, and superseded or revoked invites do not count against anyone's monthly allowance.

### 5.7a Verifiers in the pilot (agent's call)
- The owner (`OWNER_EMAIL`) is an admin and a verifier from the start.
- Verifiers see the purpose and amount of requests awaiting verification, even from people they are not connected to. That is their job, and it matches the existing behaviour.
- If a request awaiting verification has fewer than two eligible verifiers (not the borrower or trusted contact), the admin page shows "Needs another verifier" and the borrower sees "Waiting for the verification team".

### 5.7b Account deletion (P-36)
- From Profile: "Delete my account" with a typed confirmation. It is blocked while the member has an active request, money owed to them, or money they owe, with an explanation.
- On deletion, the member row is kept for the ledger. `name` becomes "Former member", and email, UPI ID and `clerk_id` are cleared or replaced with unique placeholders. `deleted_at` is set. Follows and pending invites are removed, and the Clerk user is deleted through the Clerk API. Everyone else's records stay intact.

### 5.8 Trust history (P-25)
Facts only, computed and never stored, shown to the member and their mutual connections:
- member since (month and year);
- requests repaid, and how many were repaid by the agreed due date (the final agreed date, after accepted new dates);
- number of requests they lent to (confirmed contributions).

Overdue or unpaid requests are never shown here (anti-goal: shaming).

### 5.9 Thank-you notes (P-25)
The borrower can post short notes (1 to 500 characters) on their own request once at least one contribution is confirmed. A note is visible to everyone who can see the request, and lenders get an email.

### 5.10 Receipts and statements (P-25)
- A receipt is a print-friendly page per request, visible to the borrower, the trusted contact and its lenders. It shows the purpose, amounts, every contribution and repayment with who, when, the UTR, and who confirmed it, plus the current balance. Members save a PDF with the browser's "Print" or "Save as PDF", and a "Share" button uses the Web Share API with a short text summary. No PDF library.
- A statement is the same, across all of a member's requests and loans, on their profile.

## 6. Data changes (migration `0002_customer_ready.sql`)

The migration only adds things: new columns are nullable or have defaults, and new tables are separate. It is applied to **staging first**. Production is applied only at the owner-approved release (P-4), after a read-only row count. If production has real rows in `contributions` or `repayments`, stop and ask the owner how to map them.

- `users`: add `upi_id text` (checked as `^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$`), `is_admin boolean default false`, `invite_limit integer` (null means the default), `welcomed_at timestamptz`, `terms_accepted_at timestamptz`, `deleted_at timestamptz`.
- `invites`: add `token_hash text unique`, `expires_at timestamptz not null default now() + 14 days`, `revoked_at timestamptz`, `superseded_at timestamptz`, `accepted_user_id bigint references users`. Make `token` nullable (new rows store only the hash).
- `requests`: widen the status check to add `awaiting_contact`, `contact_declined` and `withdrawn`; add `funded_cents integer`, `original_repayment_date date`, `withdrawn_at timestamptz`, `contact_decided_at timestamptz`, and the check `principal_cents between 10000 and 5000000` (added `not valid`, then validated on staging). Add the partial unique index `requests_one_active_per_borrower on (borrower_id) where status in ('awaiting_contact','contact_declined','pending_verification','open','funded')`.
- `contributions`: add `status text not null default 'confirmed' check (status in ('sent','confirmed','not_received'))`. The default `confirmed` backfills old rows; the app always inserts `sent`. Add `utr text`, `confirmed_at timestamptz`, `updated_at timestamptz`, `settled_by bigint references users`, `settled_note text`, `settled_at timestamptz`, `help_requested_at timestamptz`.
- `repayments`: add `lender_id bigint references users`, `status` (same set and default as contributions), `utr`, `confirmed_at`, `updated_at`, and the same `settled_*` and `help_requested_at` columns. New rows require `lender_id` (app rule; the column stays nullable for old rows).
- New `date_changes`: id, request_id, proposed_date, status (`pending`, `accepted`, `declined`), created_at, decided_at.
- New `date_change_votes`: date_change_id, lender_id, decision, created_at, with primary key (date_change_id, lender_id).
- New `notes`: id, request_id, author_id, body (1 to 500 characters), created_at.
- New `notifications_sent`: request_id, kind, recipient_id, sent_on date, unique on all four. This keeps reminder emails to at most one per day per kind.
- RLS is enabled on every new table, and everything is revoked from `anon` and `authenticated` (same pattern as 0001). Run the Supabase security and performance advisors after applying, and index every new foreign key.

## 7. API (Express, all under `/api`, all require sign-in except `health` and `config`)

Existing routes keep working but follow the new rules. New or changed:

- `POST /me/accept-invite {token}`: first sign-in with a link. `PATCH /me {name, upiId}`, `POST /me/welcomed`.
- `GET /home`: one call for the dashboard. It returns items needing action (contributions to confirm, repayments to confirm, verifications for verifiers, date proposals to vote on, `not_received` items to fix), then my requests and my loans with confirmed and pending totals.
- `POST /requests/:id/withdraw`, `POST /requests/:id/close` (close early at the confirmed amount), `POST /requests/:id/contact-decision {decision}` (trusted contact), `POST /requests/:id/trusted-contact {userId}` (borrower re-picks after a decline).
- `POST /contributions/:id/help`, `POST /repayments/:id/help` (ask the owner).
- `POST /me/accept-terms`, `DELETE /me` (account deletion, section 5.7b).
- `POST /requests/:id/contributions {amount, utr?}` creates a `sent` contribution. `POST /contributions/:id/confirm`, `POST /contributions/:id/not-received`, `PATCH /contributions/:id {amount?, utr?}` (lender, only while `not_received`), `DELETE /contributions/:id` (lender, not when `confirmed`).
- `POST /requests/:id/repayments {lenderId, amount, utr?}`, then `confirm`, `not-received`, `PATCH` and `DELETE` on `/repayments/:id`, mirroring contributions.
- `POST /requests/:id/date-changes {date}`, `POST /date-changes/:id/vote {decision}`.
- `POST /requests/:id/notes {body}`.
- `GET /requests/:id/receipt`, `GET /me/statement`.
- `GET /users/:id` adds `trust` (section 5.8) when the viewer is a mutual connection or the member.
- `POST /invites {email}` returns `{link, whatsappUrl, expiresAt, remainingThisMonth}`. `GET /invites` (mine), `DELETE /invites/:id` (revoke).
- Admin (needs `is_admin`): `GET /admin/members`, `POST /admin/members/:id/verifier {on}`, `POST /admin/members/:id/invite-limit {limit}`, `GET /admin/invites`, `DELETE /admin/invites/:id`, `GET /admin/stats` (invites sent and accepted, accepted members who later made or funded a request), `GET /admin/help` (entries waiting for the owner), `POST /admin/contributions/:id/settle {action: confirm|remove, note}` and the same for repayments, and `GET /admin/verification-gaps`.
- `GET /cron/daily`: Vercel Cron calls it with `Authorization: Bearer <CRON_SECRET>`, once a day at 03:30 UTC (09:00 IST). It sends reminders 7 days and 1 day before the due date and the day after it, to the borrower and trusted contact (P-11, P-28). It also closes or withdraws `open` requests that reach their due date (P-33) and flags entries waiting 7+ days (P-34). Safe to run twice.

Every amount in a request body is in rupees as a string or number with at most 2 decimals. The server converts to paise. Errors keep the existing shape `{error, fields?}`.

### Email (Resend)
Events: request approved or rejected (borrower); contribution to confirm (borrower); contribution confirmed or marked not received (lender); repayment to confirm (lender); repayment confirmed or not received (borrower); due reminders and the day-after-overdue email (borrower and trusted contact); new date proposed (lenders) and decided (borrower); thank-you note (lenders); request withdrawn (lenders with `sent` items).
- Sender `no-reply@mail.funds-for-family.routemaster.online` once that domain is verified.
- Sending is behind `EMAIL_ENABLED`, which defaults to off. While off, emails are logged without addresses. **Production sending is switched on only by the owner** (standing restriction).
- Email failures never fail the user's action. Every email has a plain-text part and a link to the request.

### WhatsApp share (no API)
The buttons build `https://wa.me/?text=<encoded message>`; the member picks the chat and sends. Messages: invite, "please confirm you received ₹X", "I've repaid ₹X, please confirm", and a gentle due-date reminder. Texts live in the strings module.

### UPI pay
`upi://pay?pa=<upi_id>&pn=<name>&am=<rupees with 2 decimals>&cu=INR&tn=Funds For Family request <id>`. On phones it is a "Pay ₹X with UPI" button; on wider screens it is a QR code (generated in the browser by a small vendored QR library, so no third-party request). If the payee has no UPI ID, the button is replaced by "Ask <name> to add their UPI ID", which shares a WhatsApp message. The app never knows whether the payment succeeded; the payer marks "sent".

## 8. Pages (Phase B and C), customer first

The look is Calm Ledger (doc 06) plus one new token, `--accent-warm` (marigold, about `#E8A33D`, checked for 4.5:1 contrast wherever it carries text). It appears only in thank-you notes, the "repaid" celebration, invite moments and the welcome. Targets are at least 44 px, the layout works from 320 px, motion respects reduced motion, and everything is reachable by keyboard.

Navigation: on phones (up to 768 px), a bottom tab bar with Home, Requests, **+ New**, Circle and Profile; on desktop, the same items in the top bar. The admin item appears only for admins.

```
┌──────────────────────────────┐
│ Good evening, Priya          │
│ ┌ Needs you (2) ───────────┐ │
│ │ Ravi sent ₹5,000.00      │ │
│ │ [Received] [Not received]│ │
│ │ Due in 7 days: ₹10,000   │ │
│ │ [Pay with UPI] [Remind]  │ │
│ └──────────────────────────┘ │
│ My request   ₹10,000 / 15,000│
│ ▓▓▓▓▓▓▓▓▓░░░░ 2 lenders      │
│ My lending   ₹3,000 owed     │
├──────────────────────────────┤
│ Home Requests (+) Circle  Me │
└──────────────────────────────┘
```

1. **Welcome**, after the first sign-in (P-32), with Terms and Privacy agreement as a required checkbox on step 1 (P-36): (1) name and UPI ID (optional, with "Why we ask: so people can pay you in one tap"); (2) "You're connected with <inviter>", plus a suggestion to invite one more person; (3) the rules on one screen: up to ₹50,000, within 12 months, no interest, both sides confirm, the app never holds money. Then Home.
2. **Home**: "Needs you" first (from `GET /home`), then my request, then my lending. Empty state for new members: "Start a request" and "Invite someone you trust".
3. **Requests**: the feed of cards (existing card model, updated: rupees, confirmed amount versus pending, no interest).
4. **New request**: amount with live `₹` formatting and the ₹50,000 limit shown, purpose with a character count, a due-date picker limited to 12 months, and a trusted-contact picker from mutual connections. If the member already has an active request, the page explains why and links to it.
5. **Request detail**: status and progress (confirmed solid, pending striped); a lender list with each lender's sent, confirmed and owed amounts; actions for the viewer's role (lend: Pay with UPI and then "I've sent it"; confirm or not received; repay a lender in instalments; propose a new date; vote; withdraw; thank-you note); a timeline of every event; and links to the receipt and WhatsApp reminders. When the request becomes repaid, a quiet marigold "Repaid. Thank you for keeping your word." banner appears.
6. **Circle**: mutual connections and the people I follow or who follow me (with a follow-back button), invite by email followed by WhatsApp share, my pending invites (copy link, revoke), and "N invites left this month".
7. **Profile**: name, UPI ID, trust history, statement link, sign out. Signing out also clears the service-worker caches.
8. **Admin**: members with a verifier toggle and invite limit; all invites with revoke; the invite funnel numbers.
9. **Receipt**: a print layout.
10. **Terms** and **Privacy**: static plain-English pages at `/terms` and `/privacy`, linked from the landing footer and the welcome step. Draft text by the agent, marked for lawyer review.
11. **Not invited**: a friendly dead end with the invite-only explanation and a link back to the landing page.

**Installable**: `manifest.webmanifest` (name, icons at 192 and 512 px from the brand mark, theme `#1f6f5c`, `display: standalone`, start URL `/app/`) and a service worker that caches the app shell (cache first) and `GET /api/*` responses (network first, falling back to the last cached copy with a "You're offline, showing your last saved view" note). It never caches POST requests or anything under `/api/admin`.

**Landing additions**: a short "Invite only: ask someone who uses it to invite you" line near the CTA, and "Add it to your home screen" in the FAQ. The copy otherwise stays as committed in `b7697c5`.

## 9. Build order and quality bar

1. **Phase A, data rules**: rules functions, migration 0002 on staging, both repos (memory and Supabase), API routes, invite-only sign-up. Test-first: unit tests for every rule in sections 5.1–5.8, API tests for every route including the 401, 403 and 404 paths and IDOR (another member's IDs), and the staging integration tests extended.
2. **Phase B, core pages**: navigation, welcome, home, new request, request detail with UPI pay and confirmations, circle with invites, profile, installable app. Playwright tests with mocked Clerk, visual baselines at 375, 768 and 1440 px, accessibility checks.
3. **Phase C, trust and growth**: trust history, receipts and statements, thank-you notes, new due dates, admin, emails and the daily job, WhatsApp texts.

Each phase: red, then green, then a mutation check; an independent review by a fresh agent (code review plus a security review); full suite green; pushed to the feature branch (preview only). A preview works only after the owner sets the staging keys in Vercel Preview.

**Owner-only actions (agent will not do these):** Vercel Preview environment keys; turning on Google sign-in in the Clerk dashboard; Resend domain DNS; `EMAIL_ENABLED` in production; `CRON_SECRET` and `OWNER_EMAIL` in Vercel; merging to `main` and applying migration 0002 to production.

## 10. Left to the builder

File and module layout inside `src/` and `public/app/`; exact copy wording (kept consistent with the landing page and plain English); the QR library choice (small, MIT-style licence, vendored); the exact marigold shade within contrast limits; test file organisation; how the memory repo models new tables.
