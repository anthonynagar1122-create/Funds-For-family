-- An owner-settled "remove" now keeps the row for audit (status removed, with settled_by, settled_note, settled_at)
-- instead of deleting it. The app leaves removed rows out of every list and total.
-- Re-runnable: the two check constraints are dropped and added again.

begin;

alter table public.contributions drop constraint if exists contributions_status_check;
alter table public.contributions add constraint contributions_status_check
  check (status in ('sent','confirmed','not_received','removed'));

alter table public.repayments drop constraint if exists repayments_status_check;
alter table public.repayments add constraint repayments_status_check
  check (status in ('sent','confirmed','not_received','removed'));

commit;
