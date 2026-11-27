# 05 - Merge record: `security/production-readiness-2026-11` into `claude/combined-production` (P-45)

Date: 2026-11-27. Branch `claude/combined-production`, created from ours (`claude/gifted-thompson-e3onnq` at `cfe326b`).
Merged: `origin/security/production-readiness-2026-11` at `af30f1f` with `git merge --no-ff`, every conflict resolved by hand
(no `-X ours/theirs`). Merge commit: `32ae813`. Nothing pushed; no database, migration, `main` or production touched.
Plan followed: `04-branch-reconciliation.md`; owner decisions P-45 to P-48 in `docs/15-product-decisions.md`.

## 1. Textual conflicts (git-reported) and how each was resolved

| File | Resolution |
|---|---|
| `src/memory-repo.js` | Kept both method blocks: ours (`listContributionsByStatus`, `listRepaymentsByStatus`) and theirs (`recordContribution`, `recordRepayment`, `reviseContribution`, `reviseRepayment`, which mirror the Postgres RPCs and idempotency). Their four methods now take an optional `at` (the app clock) so `createdAt`/`updatedAt` follow the injected test clock; without it our 7-day stuck-entry tests failed because the rows carried the real clock. The Supabase RPCs ignore `at` and use the database clock. |
| `src/supabase-repo.js` | `resolveHelpMessage`: took theirs (audited `admin_resolve_help_message` RPC, codes 42501/P0002), dropped ours (plain update). Kept their `assignHelpMessage`. Removed a second, identical `listSupportAuditEvents` that the merge left in place. Entry region: kept both our status-list helpers and their `record*`/`revise*` RPC wrappers. |
| `public/app.js` | `views` = union (`view-legal`, `view-admin`, `view-workspace`). Kept their `renderWorkspace` (`#/workspace`: verification queue, support inbox with assignment, member roles, operations, audit, all values through `esc()`) and our `renderAdmin` (`#/admin`: Members, Invites, Help, Stuck, Gaps, Stats via `pages/admin.js`). The workspace shows admins a link "Owner tools" to `#/admin`. |
| `public/app/nav.js` | Five member tabs; role entry in the header (section 4). |
| `test/api-phase-b.test.js` | Kept both test blocks (our owner-admin route tests and their role/support audit tests). |

## 2. Silent conflicts (auto-merged but wrong) and how each was resolved

| Where | Problem | Resolution |
|---|---|---|
| `src/app.js` `GET /admin/members` | Registered twice; Express served theirs, so `inviteLimit`/`invitesThisMonth` vanished. | One route, still behind `requireAdmin`: optional `?q=` search (theirs), newest first, at most 200 rows, each row `{ id, name, email, isAdmin, isVerifier, inviteLimit, invitesThisMonth, createdAt, deletedAt }`. Our members test updated to the union shape. |
| `src/app.js` `POST /admin/members/:id/verifier` | Wrote `is_verifier` directly, bypassing their audited role RPC. | Kept for the owner admin page but it now calls `repo.setMemberRoles` (keeps the target's admin flag), so every role change is in `admin_audit_events`. Self-removal still 409; RPC errors map 42501/P0002/23514 to 403/404/409. `repo.setVerifier` stays in both repos (tests and fixtures use it). |
| `listUsers` in both repos | Two definitions in each repo object (`listUsers()` ascending, all rows, vs `listUsers({query, limit})` descending, capped); the later one silently won. | One signature `listUsers({ query = '', limit = null } = {})`: newest first; `limit` 1..200, or `null` for all active members (used by stats and verification gaps). Callers: `/admin/members` (200), `/admin/operations` (200), verification gaps (all). |
| `resolveHelpMessage` signature | `(id, at)` vs `(id, at, actorId)`. | Theirs (`actorId` required by the RPC). Our Supabase error test now targets the RPC and checks the error code is kept. |
| Migrations | Two files numbered 0004 and two numbered 0005. | Section 3. |
| Owner settlement audit | Settle writes are plain row updates, so their 0005 trigger credited the borrower/lender. | New migration 0011 (section 3). |
| `test/visual/landing-*.sha256` | Their refreshed hashes fail in this environment's Chromium (they fail on their own branch here too); the landing page HTML/CSS is identical on both sides. | Kept our landing hashes, which pass here. Re-check landing screenshots in CI's browser before release. |
| `public/sw.js` | | Kept ours (privacy-bound cache, `x-ff-user`, deny list for `/api/admin` and `/api/invites`), bumped `ff-v10` to `ff-v11`. No new scripts, so `SHELL_FILES` is unchanged. |

Auto-merged and correct (checked): `src/rules.js` (`removed` status), `test/repo-contract.test.js` (both contracts; passes for the memory repo), `.env.example`/README/docs (interest removed), CI (`npm audit --audit-level=high`), `public/app/index.html` (all views present; one `#workspace-slot` added).

## 3. Migration numbering (final)

| # | File | Origin | State |
|---|---|---|---|
| 0001-0003 | `0001_init`, `0002_customer_ready`, `0003_fix_upi_check` | shared | applied on staging |
| 0004 | `0004_atomic_financial_ledger.sql` | theirs | on staging (history names `atomic_financial_ledger` (empty) + `atomic_financial_ledger_implementation`) |
| 0005 | `0005_financial_audit_actor_attribution.sql` | theirs | on staging per their docs |
| 0006 | `0006_admin_audit_and_role_management.sql` | theirs | staging unverified (`docs/13` records a timeout) |
| 0007 | `0007_index_audit_actor_foreign_keys.sql` | theirs | staging unverified |
| 0008 | `0008_utr_unique_per_request.sql` | theirs | not applied; partial unique indexes `where utr is not null`, no NOT NULL (P-46 holds as written) |
| 0009 | `0009_removed_entry_status.sql` | ours, was 0004 | never applied anywhere |
| 0010 | `0010_delete_account_fn.sql` | ours, was 0005 | never applied anywhere |
| 0011 | `0011_audit_owner_settle_attribution.sql` | new | replaces `capture_financial_ledger_event()` so an update that newly sets `settled_by` is credited to it; trigger definitions unchanged |

Updated with the renumbering: `docs/release/phase-a-production-checklist.md` (full 0004-0011 order, staging history note, read-only duplicate-UTR check before 0008) and `test/final-fixes-b.test.js` (file names; new tests: unique ordered numbers 0001-0011, 0008 keeps UTR optional, 0011 shape). No migration was applied.

## 4. Navigation decision

- Member tab bar, every width: **Home, Requests, + New, Circle, Profile** (five, 44 px targets at 320 px).
- **Requests** = open requests from mutual connections (top five from `/api/feed`, escaped, with a "See all open requests in your circle" link to `#/feed`) above the personal activity ledger. `#/feed`, `#/requests`, `#/request/:id` all light Requests. This closes **G-06**.
- Their role-aware entry is kept: **Admin** for admins, **Verify** for verifiers, href `#/workspace`, rendered in the header (`#workspace-slot`), never in the tab bar. Members get no entry; the server still enforces roles on every route.
- `#/workspace` = their workspace; `#/admin` = our owner admin page (the `admin -> workspace` hash alias was removed so both stay reachable). Both light the header entry.
- Tests: their shell tests asserted six or seven tabs (Discover, Activity, plus Admin/Verify); per the 5-tab rule they now assert the five tabs plus the header entry. Added a 320 px test (all five tabs and the Admin entry at least 44 px, no sideways scroll) and a Requests-tab feed test. `docs/12-navigation-and-ux.md` has a note describing the combined nav.

## 5. UTR change (P-46)

Their `af30f1f` made a UTR required on "sent" and on corrections. Combined behaviour:
- Optional on `POST /requests/:id/contributions`, `POST /requests/:id/repayments` and both PATCH corrections; empty or null means no UTR. A correction may keep its UTR (omit `utr`), change it, or clear it (`utr: ""`/`null`).
- When given: 6-35 letters/digits, and unique per request across contributions and repayments, case-insensitive (409 "This UPI reference is already recorded on this request"; a database 23505 maps to the same 409).
- UI: labels back to "UTR (optional)"; the client validates the format only when a UTR is typed.
- `test/utr-required.test.js` renamed `test/utr-optional-unique.test.js`: "without a UTR is refused" became "recorded with no UTR (empty or null), two such entries on one request do not clash", added "repayment without a UTR", and "correction with no UTR left is refused" became "accepted, keep, or clear". Uniqueness tests unchanged. The harness still gives fixture payments a unique UTR when a test does not pass one (comment corrected).

## 6. Journey todo tests converted to normal tests

- `lender can reach the circle feed from the app ...` (`test/journeys/lender-and-verifier.test.js`): G-06, closed by the Requests tab.
- `visitor: the README no longer describes interest and nominees` (`test/journeys/owner-newcomer-deleted.test.js`): closed by their README rewrite.

## 7. Test results

`npm test` (node 22, Playwright Chromium available): **586 tests, 516 pass, 0 fail, 70 todo** (remaining todo = known gaps for later work packages). `node --check` passes on every JS file touched; no conflict markers.

## 8. Left open

- Last administrator can still delete their own account (04 Q4, G-16/WP-7); their role RPC guards the last admin, `DELETE /me` does not.
- The owner admin page and the role workspace are two pages (linked) rather than one module; members and help appear in both. A later UI pass could fold `pages/admin.js` tabs into the workspace.
- Landing and Phase B visual baselines should be reviewed in CI's browser; their landing hashes were replaced by ours.
- Staging: confirm 0006/0007 state, run the 0008 duplicate check, apply 0008-0011, run `test/integration/supabase.integration.test.js` (owner action, staging only).
- `financial_idempotency` retention (04 Q5) and verification immutability (04 Q6) remain undecided.
- `docs/15` has no pointer to `docs/11`/`docs/12` yet (plan step 7); left for the owner's doc pass.
