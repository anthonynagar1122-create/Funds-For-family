# Phase A production release checklist

Plain-English steps for releasing Phase A (data and rules) to production. Nothing here has been run against production.
Staging already has migrations 0002 and 0003 applied, plus the security branch's 0004 and 0005 (applied by name as `atomic_financial_ledger` (empty) and `atomic_financial_ledger_implementation`; see `docs/05-integration.md`). Whether 0006 and 0007 reached staging is unverified (`docs/13` records a timeout while applying 0006): check the history before applying. 0008 to 0013 must be applied to staging too. After the P-45 branch merge and the review fixes the order is: 0001 to 0008 (security branch numbers unchanged), then 0009_removed_entry_status, 0010_delete_account_fn (ours, renumbered from 0004 and 0005; never applied anywhere), then 0011_audit_owner_settle_attribution, 0012_settle_entry_rpc and 0013_delete_account_cleanup (review fixes, `docs/production-readiness/06-merge-review-fixes.md`). Do each step in order and stop if a check does not come back as expected.

## 1. Read-only checks on the production database

Run these in the Supabase SQL editor for the production project. They only read data.

**a. Borrowers with more than one active request.** Expected: no rows. The new rules allow one active request per borrower.

```sql
select borrower_id, count(*) as active_requests
from public.requests
where status in ('pending_verification', 'open', 'funded')
group by borrower_id
having count(*) > 1;
```

**b. Active requests whose amount is outside Rs 100 to Rs 50,000.** Amounts are stored in paise, so the range is 10000 to 5000000. Expected: no rows.

```sql
select id, borrower_id, status, principal_cents
from public.requests
where status in ('pending_verification', 'open', 'funded')
  and (principal_cents < 10000 or principal_cents > 5000000);
```

**c. How many contribution and repayment rows exist.** Spec section 6: if either count is above zero, stop and ask the owner how the old rows should be mapped before going further.

```sql
select
  (select count(*) from public.contributions) as contributions,
  (select count(*) from public.repayments)    as repayments;
```

**d. Repayments with no lender.** Old repayments have no `lender_id`. The app ignores them in totals, but the owner should know they exist. Expected: no rows, or a number the owner has seen.

```sql
select id, request_id, payer_id, amount_cents, created_at
from public.repayments
where lender_id is null;
```

**e. Invites that still hold a plain-text token.** The new code stores only a hash. Expected: no rows. Any row returned is a live invite link stored in readable form; tell the owner before continuing.

```sql
select id, inviter_id, email, created_at, accepted_at
from public.invites
where token is not null;
```

## 2. Apply the migrations (only after the owner approves)

1. Get the owner's explicit approval, in writing, for the release.
2. Apply `supabase/migrations/0002_customer_ready.sql`. It runs inside a single transaction, so a failure leaves nothing half done.
3. Check it finished without errors, then apply `supabase/migrations/0003_fix_upi_check.sql`. It is also a single transaction.
4. Apply the security branch migrations in order: `0004_atomic_financial_ledger.sql`, `0005_financial_audit_actor_attribution.sql`, `0006_admin_audit_and_role_management.sql` (each runs inside its own transaction), then `0007_index_audit_actor_foreign_keys.sql`, which has no `begin`/`commit`: it is five separate `create index if not exists` statements, each committed on its own. If one fails, the earlier indexes stay; it is safe to re-run after fixing the cause. On staging, check the history first: 0004 and 0005 are already there under the names `atomic_financial_ledger` (empty) and `atomic_financial_ledger_implementation`, and 0006/0007 may be; do not apply them twice and do not run `supabase db push` from a fresh checkout until the history is reconciled.
5. Before `0008_utr_unique_per_request.sql`, run this read-only duplicate check; it must return no rows, because the unique index creation fails on existing duplicates. A UTR stays optional (P-46): the index only covers rows where a UTR is given.

   ```sql
   select request_id, upper(utr) as utr, count(*) from public.contributions where utr is not null group by 1, 2 having count(*) > 1
   union all
   select request_id, upper(utr), count(*) from public.repayments where utr is not null group by 1, 2 having count(*) > 1;
   ```

   Then apply `supabase/migrations/0008_utr_unique_per_request.sql`.
6. Apply `supabase/migrations/0009_removed_entry_status.sql` after 0008 (single transaction). Then run this read-only check; both rows must list the `'removed'` status value:

   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('contributions_status_check','repayments_status_check');
   ```

7. Apply `supabase/migrations/0010_delete_account_fn.sql` after 0009 (single transaction). It adds `public.delete_member_account`, which account deletion calls; without it, deleting an account fails.
8. Apply `supabase/migrations/0011_audit_owner_settle_attribution.sql` after 0010 (single transaction). It replaces the financial audit trigger function so an owner settlement is credited to `settled_by`.
   Then apply `supabase/migrations/0012_settle_entry_rpc.sql` after 0011 (single transaction). It adds `public.settle_contribution` and `public.settle_repayment` (the owner settle routes call them; without them settling fails) and recreates the two UTR unique indexes from 0008 with `where utr is not null and status <> 'removed'`, so a removed entry releases its UTR.
   Then apply `supabase/migrations/0013_delete_account_cleanup.sql` after 0012 (single transaction). It replaces `public.delete_member_account` so account deletion also clears `help_messages.assigned_to` for that member.
9. 0008 to 0013 must be applied to staging, and the Supabase contract suite (`test/integration/supabase.integration.test.js`) run against staging, before any production release.
10. Do not apply them to production by any other route than the approved release.

## 3. Make the owner an admin and verifier

The owner's row may already exist. After the migrations, set the flags (replace the email with the owner's real, verified email):

```sql
update public.users
set is_admin = true, is_verifier = true
where lower(email) = lower('OWNER_EMAIL_HERE');
```

The app also promotes the owner automatically on their next sign-in, but only when the sign-in email is verified in Clerk and matches `OWNER_EMAIL`. Run the statement anyway so the state is certain, then confirm one row was updated.

## 4. Email sending

- Check whether `RESEND_API_KEY` is set in the production environment (Vercel project settings). If it is set, the app can send real email to members.
- Confirm the owner has approved sending real email. Do not leave the key set without that approval.
- `EMAIL_ENABLED` is the master switch and defaults to off. While it is off (or unset) no email is sent by any path, even if `RESEND_API_KEY` is set; the log shows "email skipped: EMAIL_ENABLED is off". Set it to `true` only after the owner approves real email.
- Backups, incidents, key rotation and the owner-only switches are in [operations.md](operations.md). Confirm daily backups and run the restore drill there before launch.

## 5. Integration tests against staging

Before release, run the real-database tests against the STAGING project (never production; the test refuses a production URL):

```
SUPABASE_URL=<staging url> SUPABASE_SECRET_KEY=<staging service key> npm run test:integration
```

They must all pass. Without credentials the tests skip, and a skip is not a pass.

## 6. Clerk settings

- Email address verification is required for sign-up (Clerk dashboard, user and authentication, email). The app now ignores any email that Clerk has not verified, so an unverified person cannot be admitted as the owner or through an email invite, and cannot join with an invite link until they verify their email.
- Google sign-in is enabled only if the owner wants it. It is the owner's choice; do not switch it on without them.

## 7. Environment variables

- `OWNER_EMAIL`: the owner's verified email. Whoever signs in with this email (verified in Clerk) is admitted as admin and verifier.
- `EMAIL_ENABLED`: leave `false` (or unset) unless the owner has approved email.
- `CRON_SECRET`: needed in Phase C for scheduled jobs. Not required for Phase A, but set it before Phase C goes live.
- Existing variables (Clerk keys, Supabase URL and service key, `APP_URL`) must already be correct for production.
