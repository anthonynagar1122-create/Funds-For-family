# Phase A production release checklist

Plain-English steps for releasing Phase A (data and rules) to production. Nothing here has been run against production.
Staging already has migrations 0002 and 0003 applied; 0004 and 0005 must be applied to staging too. Do each step in order and stop if a check does not come back as expected.

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
4. Apply `supabase/migrations/0004_removed_entry_status.sql` after 0003 (single transaction). Then run this read-only check; both rows must list the `'removed'` status value:

   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('contributions_status_check','repayments_status_check');
   ```

5. Apply `supabase/migrations/0005_delete_account_fn.sql` after 0004 (single transaction). It adds `public.delete_member_account`, which account deletion calls; without it, deleting an account fails.
6. 0004 and 0005 must be applied to staging, and the Supabase contract suite (`test/integration/supabase.integration.test.js`) run against staging, before any production release.
7. Do not apply them to production by any other route than the approved release.

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
- `EMAIL_ENABLED` is a Phase C setting and does not exist yet. Until then, the only switch is whether `RESEND_API_KEY` is set. With no key, the app logs "email skipped" and sends nothing.

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
- `CRON_SECRET`: needed in Phase C for scheduled jobs. Not required for Phase A, but set it before Phase C goes live.
- Existing variables (Clerk keys, Supabase URL and service key, `APP_URL`) must already be correct for production.
