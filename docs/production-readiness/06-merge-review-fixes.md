# 06 - Merge review fixes on `claude/combined-production`

Date: 2026-11-28. Base: `f321172` (merge record, `05-merge-record.md`). Work was test-first: the failing tests were
committed first (`5cb9a62`), then each fix. No migration applied, no database touched, nothing deployed or pushed.

Commits:

| Commit | Content |
|---|---|
| `5cb9a62` | Failing tests: `test/merge-review-fixes.test.js` (new), six contract tests in `test/repo-contract.test.js` |
| `5409f97` | Important 1: idempotent retry replays |
| `babb17e` | Important 2: locked settle RPCs (migration 0012, also the UTR index predicate) |
| `3704bbf` | Minor: 0013 delete cleanup, `countUsers`, checklist wording, repo comment |
| this file | Report |

## Important 1 - an idempotent retry replays instead of 409

**Finding.** `POST /requests/:id/contributions` and `POST /requests/:id/repayments` ran `utrTakenOnRequest` and the cap
rules before `repo.record*`. After a committed first call, a retry with the same `Idempotency-Key` hit those
pre-checks (its own UTR is now "taken", the cap is now full, the request may be funded/repaid) and got 409 instead of
the saved entry.

**Change.**
- New repo method `findIdempotentEntry({ operation, actorId, idempotencyKey })` in both repos. Memory: reads the
  existing `financialIdempotency` map. Supabase: `select response from financial_idempotency where operation, actor_id,
  idempotency_key` (the table from 0004); a `null` response (create in flight) reads as `null`, so the record RPC
  still answers that case ("still processing").
- `src/app.js` `idempotentReplay()`: when the header is present it validates the key, looks it up before any
  pre-check, and replays `201 { contribution|repayment, request }` when the saved entry matches the body (request,
  amount, UTR; plus lender for repayments). A different body gets the same refusal as the RPC: 409 "This idempotency
  key was already used for a different contribution/repayment". No header: a fresh key, nothing replayed. A replay
  sends no email.
- Repayments: the `status !== 'funded'` check moved after the replay lookup, so a retry still replays once the request
  is `repaid`. Validation order for first calls is otherwise unchanged.

**Tests** (`test/merge-review-fixes.test.js`, `test/repo-contract.test.js`):
- `I-1 contribution: a retry with the same key and body replays the saved entry, even with a UTR and a full cap`
- `I-1 contribution: the same key with a different body is still refused`
- `I-1 repayment: a retry replays the saved entry with a UTR, with the cap full and after the request is repaid`
- `I-1: without an Idempotency-Key a repeated UTR is still refused` (guard; passed before and after)
- `contract: findIdempotentEntry returns the entry a committed idempotent create saved, or null`
- `Supabase findIdempotentEntry reads the saved response by operation, actor and key`

RED: the three I-1 route tests failed with `409 {"error":"This UPI reference is already recorded on this request"}`
(expected 201); the contract/Supabase tests failed with `findIdempotentEntry is not a function`. GREEN after `5409f97`.

## Important 2 - owner settle uses a locked, atomic write

**Finding.** `/admin/contributions/:id/settle` and `/admin/repayments/:id/settle` checked the cap in the app and then
wrote with `updateContribution`/`updateRepayment`, without the request-row lock the record RPCs take.

**Change.**
- `supabase/migrations/0012_settle_entry_rpc.sql` (begin/commit, re-runnable): `settle_contribution(p_entry_id,
  p_actor_id, p_action, p_note, p_at)` and `settle_repayment(...)`, security invoker. Each reads the entry's request,
  locks the request row `FOR UPDATE` (same order as the record RPCs), then the entry; re-checks status `sent`/`not_received`
  (else 55000), actor is not payer/receiver (42501), missing entry (P0002), bad action (22023); on confirm re-checks the
  cap (23514) and sets `status confirmed, confirmed_at, updated_at, settled_by, settled_note, settled_at`; on remove sets
  `status 'removed'` with the settled fields (never deletes). It sets `app.financial_actor_id` so the 0011 audit trigger
  credits the owner. Execute revoked from public, anon, authenticated; granted to service_role (as 0004/0006 do).
- Cap rule used: contribution `sent+confirmed of the others + this amount <= principal`; repayment `sent+confirmed
  repayments to this lender (others) + this amount <= lender's confirmed lent`. The brief said "confirmed repaid" for
  repayments; I used sent+confirmed because that is what `record_repayment`, `revise_repayment` and the existing app
  check reserve, so the settle path is never looser than creation. Stricter than the brief's wording; flagged.
- Memory repo: `settleContribution`/`settleRepayment` as one synchronous section with the same codes.
- Supabase repo: both call `db.rpc` and keep the error code.
- Route `adminSettle`: keeps the app checks (action, note 5-500, 7-day rule, self-settle 409, friendly cap message),
  then calls `repo.settle*`; codes map 42501 -> 403, P0002 -> 404, 23514 -> 409, 55000 -> 409, 22023 -> 400; anything
  else is rethrown (500). `settleFunded`/`settleRepaid` still run afterwards on confirm.
- Existing test `settle routes: a throwing repo gives a 500 JSON error ...` (`test/api-phase-b.test.js`) now stubs
  `settleContribution` instead of `updateContribution` (the write it guards moved); intent unchanged.

**Tests:**
- `contract: settleContribution confirms or removes a waiting entry with the settle audit fields`
- `contract: settleContribution refuses cap (23514), self-settle (42501), missing (P0002), wrong status (55000)`
- `contract: settleRepayment confirms or removes, and refuses cap, self-settle, missing and wrong status`
- `I-2 settle routes write through repo.settleContribution / settleRepayment, never a plain update`
- `I-2 settle routes map settle errors: 42501 -> 403, P0002 -> 404, 23514 and 55000 -> 409`
- `Supabase settleContribution / settleRepayment call their RPCs with the five arguments and map the row`
- `migration 0012 defines locked settle RPCs, service-role only, and UTR indexes that skip removed rows`
- `migration numbers are unique and in order 0001-0013 after the merge and review fixes` (`test/final-fixes-b.test.js`, updated)

RED: contract and Supabase tests `settleContribution is not a function`; route test 500 (spy forbade the plain
update); error-mapping test got 200 (stub not called); migration test ENOENT. GREEN after `babb17e`.

## Minor fixes

| Finding | Change | Tests (RED -> GREEN) |
|---|---|---|
| `supabase-repo.js` comment said migration 0005 | Now "migration 0010, replaced by 0013" | `the Supabase repo comment names migration 0010 for delete_member_account` (regex failed -> passes) |
| Removed rows and UTR | 0012 drops and recreates `contributions_request_utr_key` / `repayments_request_utr_key` with `where utr is not null and status <> 'removed'`. Memory repo and `utrTakenOnRequest` already skipped removed rows. | `a UTR from an entry the owner removed can be used again on the same request` (regression guard: passed before, as the app path already ignored removed rows; the DB side is covered by the 0012 migration test) |
| `delete_member_account` left help assignments | `0013_delete_account_cleanup.sql` (begin/commit) replaces the function with the 0010 body plus `update public.help_messages set assigned_to = null where assigned_to = p_user_id`; revoke kept. Memory `deleteAccount` mirrors it. | `contract: deleteAccount clears help-message assignments that point at the deleted member` (assignedToId stayed set -> null); `migration 0013 replaces delete_member_account and clears help-message assignments` (ENOENT -> passes) |
| Checklist wording | 0004-0006 "each runs inside its own transaction"; 0007 described as having no `begin`/`commit` (five separate index statements, safe to re-run); apply order now 0008-0013 with steps for 0012 and 0013 | `the production checklist does not call 0007 a single transaction and lists 0012 and 0013 in order` |
| `/admin/operations` counted the 200-row list | `countUsers({ role })` in both repos (Supabase: `head: true, count: 'exact'`, `deleted_at is null`, optional `is_admin`/`is_verifier`); the route uses three counts | `/admin/operations counts every active member, not just the first 200 rows` (200 -> 206); `contract: countUsers counts active members, admins and verifiers without a row cap`; `Supabase countUsers uses an exact head count, filtered by role and active members` |

## Test results

- RED at `5cb9a62`: `test/merge-review-fixes.test.js` 2 pass / 13 fail; `test/repo-contract.test.js` 18 pass / 6 fail.
- GREEN at `3704bbf`: `npm test` (node 22) **607 tests: 537 pass, 0 fail, 70 todo** (was 586 / 516 / 0 / 70 in `05`;
  +21 tests, todo unchanged).

## Not done / for the owner

- 0012 and 0013 are not applied anywhere. Apply after 0011 on staging, then run
  `test/integration/supabase.integration.test.js` (it runs the new contract cases against the real RPCs). Until 0012
  is applied, the owner settle routes fail on Supabase (the RPCs do not exist yet).
- 0012 recreates two indexes inside one transaction; on a large table that holds a lock for the build. Fine at current
  size.
- The repayment cap in `settle_repayment` reserves sent+confirmed (see Important 2), not only confirmed.
