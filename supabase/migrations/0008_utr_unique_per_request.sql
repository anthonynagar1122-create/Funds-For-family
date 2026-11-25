-- A UPI reference (UTR) identifies one bank transfer. It may be recorded at most once per request, compared
-- case-insensitively. These partial unique indexes make the rule hold under concurrent writes; legacy rows
-- without a UTR are not constrained. A UTR shared between a contribution and a repayment on the same request
-- is refused by the API (src/app.js utrTakenOnRequest), not by the database.

begin;

create unique index if not exists contributions_request_utr_key
  on public.contributions (request_id, upper(utr))
  where utr is not null;

create unique index if not exists repayments_request_utr_key
  on public.repayments (request_id, upper(utr))
  where utr is not null;

commit;
