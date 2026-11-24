# Phase B: Customer Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give members real pages for welcome, home, requests, circle and invites, profile and help, plus an owner-only admin page, on top of the Phase A API. Installable on a phone.

**Architecture:** Plain HTML/JS modules in `public/app/`, no build step. One hash router in `public/app.js`. Each page is a module that renders into `<main>` with `esc()` for every untrusted value. Backend additions are small routes in `src/app.js` plus repo methods in both repos with contract tests. Emails stay off (Phase C).

**Tech Stack:** Node 22, Express 4, `node:test`, Playwright (mocked Clerk and mocked API), plain JS.

**Spec:** `docs/superpowers/specs/2026-11-23-customer-ready-design.md` (sections 5.5a, 5.7b, 5.8, 5.10, 7, 8). Decisions: `docs/15-product-decisions.md` P-21 to P-44.

## Global Constraints

- Money: paise internally; display `₹` with Indian grouping via `Money.formatInr`. Amounts typed by users go to the API as strings.
- Every untrusted value through `esc()`; never `innerHTML` with raw API text.
- User-facing words: "trusted contact" (never nominee/guarantor), no "interest" anywhere.
- Targets ≥ 44 px; layout works from 320 px; `prefers-reduced-motion` respected; keyboard reachable; focus visible.
- Bottom tab bar on phones (≤ 768 px), top bar on desktop (P-30).
- No email sending in this phase: emails stay behind the existing code paths; new routes do not send mail.
- Service worker never caches POST, anything under `/api/admin`, or responses containing another member's data.
- Do not apply migrations to any database. Do not push to `main`.

## Review Focus

1. A member who is not mutual with a borrower must not see that borrower's request, UPI, or trust history on any page (404 or blank, never data).
2. Admin routes and admin page are closed to non-admins (403 on API, page hidden).
3. Invite link token is never rendered as text, written to the URL after first load, or cached by the service worker.
4. Account deletion is blocked while money is owed either way, and never deletes ledger rows.
5. Offline: the shell opens; API data shows only last saved view with a visible "offline" note; no stale money figure is presented as current without that note.

---

## File map

- Modify `public/app.js`: becomes the router and session bootstrap only.
- Create `public/app/nav.js`: tab bar and top bar, role-aware (admin item only for admins).
- Create `public/app/pages/welcome.js`, `home.js`, `new-request.js`, `request.js`, `circle.js`, `profile.js`, `help.js`, `admin.js`, `not-invited.js`.
- Create `public/app/format.js` (dates, initials, avatar circle) and reuse `money.js`.
- Create `public/app/api.js` (fetch wrapper, error mapping, offline note).
- Create `public/manifest.webmanifest`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/sw.js`.
- Modify `public/app/index.html`, `public/styles.css` (new tokens: `--color-accent-warm` marigold, tab bar, responsive rules).
- Backend: `src/app.js`, `src/memory-repo.js`, `src/supabase-repo.js`, `src/rules.js`, `src/services.js` (only if needed).
- Tests: `test/pages/*.e2e.test.js` (one per page), `test/api-phase-b.test.js`, `test/repo-contract.test.js` extended, `test/sw.test.js`, `test/visual/` baselines for 375, 768, 1440 px.

---

### Task 1: Router, shell and responsive navigation

**Files:** Create `public/app/nav.js`, `public/app/api.js`, `public/app/format.js`; modify `public/app.js`, `public/app/index.html`, `public/styles.css`; test `test/pages/shell.e2e.test.js`.

**Interfaces:**
- Produces: `Router.go(hash)`, `Router.register(name, renderFn)`, `Api.get/post/patch/delete(path, body?)` throwing `ApiError {status, code, field, message}`, `Format.initials(name)`, `Format.avatar(user)` returning markup with `esc()`.

- [ ] **Step 1: Failing tests.** Desktop 1280 px shows top nav with 5 items (Home, Requests, Circle, Profile; Admin only for admins). Phone 375 px shows bottom tab bar with Home, Requests, `+ New`, Circle, Profile at ≥ 44 px targets. `#/circle` renders circle; unknown hash renders home. Tab with `aria-current="page"` on the active route. Admin tab absent when `me.isAdmin` is false.
- [ ] **Step 2:** Run `node --test test/pages/shell.e2e.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** router (hash based), nav, API wrapper, format helpers. Keep the existing feed/detail code working behind the router until Tasks 3–5 replace it.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `npm test` once. Expected: green.
- [ ] **Step 5:** Commit `feat: router, responsive navigation and API client`.

### Task 2: Installable app and offline shell

**Files:** Create `public/manifest.webmanifest`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/sw.js`; modify `public/app/index.html`; test `test/sw.test.js` (node) and `test/pages/install.e2e.test.js`.

**Interfaces:** `sw.js` caches the app shell (`/app/`, `/app/index.html`, `/styles.css`, `/app.js`, `/app/*.js`, icons) cache-first, and `GET /api/*` network-first with last-saved fallback for `/api/home`, `/api/feed`, `/api/me`, `/api/activity` only. It must never cache POST/PATCH/DELETE or any `/api/admin/*`, and must never cache `/api/invites`.

- [ ] **Step 1: Failing tests.** Manifest has `display: standalone`, `start_url: /app/`, `theme_color: #1f6f5c`, both icon sizes. Node test on `sw.js` source: the deny-list rules are present (static check of the allow-list constants). Playwright: with the context offline after first load, `/app/` still renders and shows the offline note.
- [ ] **Step 2:** Run; Expected: FAIL.
- [ ] **Step 3: Implement.** Icons generated from the existing brand mark (`public/app/index.html` favicon SVG, 28 px rect with F) at 192 and 512 px using the browser in the sandbox; check the PNG visually.
- [ ] **Step 4:** Run tests. Expected: PASS. `npm test` green.
- [ ] **Step 5:** Commit `feat: installable web app with offline shell`.

### Task 3: Welcome and first-visit flow (backend + page)

**Files:** Modify `src/app.js`, `src/rules.js`; `public/app/pages/welcome.js`, `public/app/pages/not-invited.js`; tests `test/api-phase-b.test.js`, `test/pages/welcome.e2e.test.js`.

**Interfaces:**
- Existing: `PATCH /api/me {name, upiId}`, `POST /api/me/accept-terms`, `POST /api/me/welcomed`.
- Rule: welcome is required when `welcomedAt` is null. Terms required when `termsAcceptedAt` is null.

- [ ] **Step 1: Failing API tests.** `/me` includes `welcomedAt` and `termsAcceptedAt` for the owner. `accept-terms` sets the timestamp and is idempotent (second call keeps the first timestamp). `welcomed` likewise. `PATCH /me` with an invalid UPI returns 400 field `upiId` (already exists — keep it).
- [ ] **Step 2: Failing browser tests.** First visit shows step 1 (name prefilled from Clerk, UPI optional with the "why we ask" hint, terms checkbox required before Continue). Step 2 shows "You're connected with <inviter name>" when an invite exists, and the "invite one more person" suggestion. Step 3 shows the three rules: up to ₹50,000, within 12 months, no interest, both sides confirm, the app never holds money. "Finish" calls `welcomed` and routes to Home.
- [ ] **Step 3:** Run; Expected: FAIL.
- [ ] **Step 4: Implement** the page and any missing route fields. The inviter name comes from `GET /api/invites`?state=accepted — add `inviterName` on `/me` for the owner when `acceptedUserId` links to an inviter (repo lookup on `invites` by `accepted_user_id`).
- [ ] **Step 5:** Run; PASS. `npm test` green.
- [ ] **Step 6:** Commit `feat: welcome flow and terms acceptance`.

### Task 4: Home overview

**Files:** Modify `src/app.js` only if `/home` lacks a field; `public/app/pages/home.js`; tests `test/pages/home.e2e.test.js`.

**Interfaces:** Consumes `GET /api/home` → `{ needsYou, myRequests, myLending }` (Phase A Task 9). Action kinds: `confirm_contribution`, `confirm_repayment`, `fix_contribution`, `fix_repayment`, `contact_decision`, `verify`, `repick_contact`.

- [ ] **Step 1: Failing tests.** "Needs you" appears first with a count, each item shows the amount and who (name only), and links to the request. Empty states: "Start a request" and "Invite someone you trust" when nothing exists. My request card shows confirmed vs pending in rupees with a progress bar and text, not colour alone. My lending shows owed amount per request. Verifier items appear only when `/home` returns them.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `npm test` green.
- [ ] **Step 5:** Commit `feat: home overview with needs-you list`.

### Task 5: New request form

**Files:** `public/app/pages/new-request.js`; tests `test/pages/new-request.e2e.test.js`.

**Interfaces:** `POST /api/requests {amount, purpose, category, repaymentDate, trustedContactId}`. Trusted-contact picker lists `GET /api/users` (empty q = mutual connections).

- [ ] **Step 1: Failing tests.** Amount field shows live `₹` formatting on blur and the limit "₹100 to ₹50,000"; over the limit shows an inline error before submit. Purpose shows a character count (20 to 2,000). Due date input `max` is 12 months ahead; server 400 maps to the field. Category select has the seven values. Trusted contact picker shows only mutual connections; with none, it says "Connect with someone first" and links to Circle. If the member already has an active request, the page explains and links to it instead of the form. Double-submit is prevented (button disabled while in flight).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `npm test` green.
- [ ] **Step 5:** Commit `feat: new request form with limits and trusted contact picker`.

### Task 6: Request detail, role actions and UPI pay

**Files:** `public/app/pages/request.js` (replaces the Phase A detail view); tests `test/pages/request.e2e.test.js`.

**Interfaces:** Consumes `GET /api/requests/:id` (totals, lenders, payTo, contributions, repayments, verifications, rejectionReason for borrower only). Actions per role are the Phase A ones.

- [ ] **Step 1: Failing tests.** Status and progress (confirmed solid, pending striped, plus text). Lender rows with lent, repaid, owed. Pay with UPI button `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…` built from `payTo` only, shown on phones; on wider screens a QR code rendered in the browser by a vendored tiny QR library (add file `public/vendor/qr.js` with licence header). When the payee has no UPI ID: "Ask <name> to add their UPI ID" with a WhatsApp share button. "I've sent it" with optional UTR (validated client side with the same pattern, server still authoritative). Repaid banner only when status is repaid. Timeline of events from contributions/repayments timestamps. Not visible → "This request is not available to you" (404 handled, no data shown).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Include WhatsApp reminder buttons for borrower/trusted contact on overdue requests (prefilled text, no API).
- [ ] **Step 4:** PASS; `npm test` green.
- [ ] **Step 5:** Commit `feat: request detail with role actions and UPI pay`.

### Task 7: Circle, invites and follow-back

**Files:** Modify `src/app.js` (add `POST /api/follows` already exists; add `GET /api/circle` if needed); `public/app/pages/circle.js`; tests `test/api-phase-b.test.js`, `test/pages/circle.e2e.test.js`.

**Interfaces:** `GET /api/connections` → `{following, followers, mutual}`; `GET /api/invites`; `POST /api/invites {email}` → `{invite, link, whatsappUrl, remainingThisMonth}`; `DELETE /api/invites/:id`; `DELETE /api/follows/:userId`.

- [ ] **Step 1: Failing tests.** Three lists: mutual, following only, followers only (with a follow-back button). Invite form: email, then the result shows the WhatsApp share button (`https://wa.me/?text=`) and "Copy link"; "N invites left this month". My invites list with state and revoke. Over allowance → message from server. The link is shown once, never written to the URL or storage. Avatar circles with initials.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `npm test` green.
- [ ] **Step 5:** Commit `feat: circle with follow-back and invite sharing`.

### Task 8: Profile, statement, email preferences and account deletion

**Files:** Modify `src/app.js`, `src/memory-repo.js`, `src/supabase-repo.js`, `src/rules.js`; create `public/app/pages/profile.js`; tests `test/api-phase-b.test.js`, `test/repo-contract.test.js`, `test/pages/profile.e2e.test.js`.

**Interfaces:**
- `PATCH /api/me/email-preferences {reminders, thanks}` (essential emails cannot be turned off; the route accepts only these two booleans).
- `GET /api/users/:id` adds `trust` only when the viewer is that member or a mutual connection: `{memberSince, repaidCount, repaidOnTimeCount, lentToCount}` (computed, never stored; overdue or unpaid never shown).
- `GET /api/me/statement`: the member's requests and loans with amounts, status, dates, UTR, as JSON; the page renders it and offers Print/Save as PDF.
- `DELETE /api/me {confirm: 'DELETE'}`: blocked (409) while the member has an active request or money owed either way; otherwise sets `deletedAt`, name "Former member", clears email, upiId, avatarUrl, replaces clerkId with a unique placeholder, removes follows and open invites. Ledger rows kept.
- Repo: `deleteAccount(id)` in both repos + contract test.

- [ ] **Step 1: Failing API tests** for each route, including 403/404 cases, that owed-money blocks deletion, that deleted members disappear from search and connections, and that trust is absent for non-mutual viewers.
- [ ] **Step 2: Failing contract tests** for `deleteAccount`.
- [ ] **Step 3: Failing browser tests:** profile shows photo or initials, name, UPI, trust history, statement link, email preferences toggles (essential ones shown as always on), "Get help" form (min 10 characters; posts to `POST /api/help`), delete account (typed confirmation; shows the reason when blocked), sign out.
- [ ] **Step 4:** FAIL, then implement; PASS; `npm test` green.
- [ ] **Step 5:** Commit `feat: profile, trust history, statement, email preferences and account deletion`.

### Task 9: Help requests

**Files:** Modify `src/app.js`, both repos (`addHelpMessage`, `listHelpMessages(status)`, `resolveHelpMessage(id)`), contract test; `public/app/pages/help.js` (form inside profile); tests.

**Interfaces:** `POST /api/help {body}` (10 to 2,000 characters) → 201; `GET /api/admin/help-messages` (admin); `POST /api/admin/help-messages/:id/resolve` (admin). No email is sent here (Phase C).

- [ ] **Step 1: Failing tests:** 400 field `body` on short text; members see only their own messages; admin list 403 for non-admin; resolve sets `resolvedAt`.
- [ ] **Step 2:** FAIL; implement; PASS; `npm test` green.
- [ ] **Step 3:** Commit `feat: help requests from members, reviewed by owner`.

### Task 10: Admin page

**Files:** Modify `src/app.js` (admin routes behind a `requireAdmin` middleware), repos + contract tests; `public/app/pages/admin.js`; tests `test/api-phase-b.test.js`, `test/pages/admin.e2e.test.js`.

**Interfaces:**
- `requireAdmin`: 403 `{error:'Admins only'}` unless `req.user.isAdmin`. Applies to every `/api/admin/*` route.
- `GET /api/admin/members` → members with `isVerifier`, `inviteLimit`, `invitesThisMonth`.
- `POST /api/admin/members/:id/verifier {on}`; `POST /api/admin/members/:id/invite-limit {limit}` (0 to 50).
- `GET /api/admin/invites` (all, with state), `DELETE /api/admin/invites/:id` (revoke).
- `GET /api/admin/stats` → invites sent, accepted, accepted members who later made or funded a request.
- `GET /api/admin/verification-gaps` → requests in `pending_verification` with fewer than two eligible verifiers.
- `POST /api/admin/contributions/:id/settle {action:'confirm'|'remove', note}` and the same for repayments (note 5 to 500 characters; admin cannot settle an entry where they are payer or receiver; records `settledBy`, `settledNote`, `settledAt`; 409 unless the entry is `sent` or `not_received` and untouched for 7 days, per P-34).
- `GET /api/admin/stuck` → entries waiting 7+ days (for the settle queue).

- [ ] **Step 1: Failing API tests:** every admin route 403 for a member and 401 for anonymous; verifier toggle; invite limit bounds; revoke; stats numbers from fixture data; settle rules (7-day rule, self-settle blocked, note required, both sides emailed is deferred to Phase C — assert no email call here).
- [ ] **Step 2: Failing browser tests:** page hidden for non-admins; admin sees tabs: Members, Invites, Help, Stuck, Stats, Gaps; each action shows the result in text.
- [ ] **Step 3:** FAIL; implement; PASS; `npm test` green.
- [ ] **Step 4:** Commit `feat: owner admin page for verifiers, invites, help, stuck entries and stats`.

### Task 11: Phase B quality pass

**Files:** visual baselines in `test/visual/` for the pages at 375, 768, 1440 px; accessibility checks.

- [ ] **Step 1: Failing tests.** Playwright axe-style checks run inline (no new dependency): every page has one `h1`, labelled form controls, buttons with text, colour contrast ≥ 4.5:1 for body text (check tokens with the existing contrast helper from `test/landing.e2e.test.js`), no horizontal scroll at 320 px, targets ≥ 44 px on phone widths.
- [ ] **Step 2:** Run; fix; regenerate baselines intentionally with `UPDATE_VISUAL=1` only after reviewing each screenshot.
- [ ] **Step 3:** `npm test` green. Mutation check: remove `esc()` from one purpose render → a test must fail; restore.
- [ ] **Step 4:** Commit `test: Phase B accessibility and visual baselines`.

---

## Deferred to Phase C (explicitly out of this plan)

Email sending and `EMAIL_ENABLED`, daily cron, due-date reminders, new due-date proposals, thank-you notes, receipts as printable pages, the "follow back" suggestion after a decline, `INVITES_PER_MONTH` env override, and staging integration runs. Phase B's pages show these as "coming soon" only where a link would otherwise lead nowhere — there are none planned.
