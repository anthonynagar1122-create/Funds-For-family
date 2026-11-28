-- 0012 (06-merge-review-fixes): owner settlement (P-34, /admin/*/settle) as locked, atomic writes.
-- Before this migration the settle routes checked the cap in the app and then wrote the entry with a plain update,
-- without the request-row lock that record_contribution/record_repayment take, so a concurrent create or confirm could
-- slip past the cap. settle_contribution and settle_repayment lock the request row FOR UPDATE, re-check the entry's
-- status, that the actor is neither payer nor receiver, and (on confirm) the cap, then write the settle audit fields.
-- "remove" keeps the row with status 'removed' (0009); nothing is ever deleted. The app keeps its own checks (7-day
-- rule, note length) and still recomputes the request (settleFunded/settleRepaid) afterwards.
-- Error codes: 23514 cap, 42501 self-settle, P0002 missing entry, 55000 entry not waiting, 22023 bad action.
--
-- Also: removed rows release their UTR. The 0008 partial unique indexes are recreated (same names) with the
-- predicate `utr is not null and status <> 'removed'`, matching the app's utrTakenOnRequest and the memory repo.
--
-- Apply after 0011. Re-runnable (create or replace; drop index if exists then create).
begin;

create or replace function public.settle_contribution(
  p_entry_id bigint,
  p_actor_id bigint,
  p_action text,
  p_note text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request_id bigint;
  v_request public.requests%rowtype;
  v_entry public.contributions%rowtype;
  v_reserved bigint;
  v_at timestamptz := coalesce(p_at, now());
begin
  if p_action is null or p_action not in ('confirm', 'remove') then
    raise exception 'Choose confirm or remove' using errcode = '22023';
  end if;
  select request_id into v_request_id from public.contributions where id = p_entry_id;
  if not found then raise exception 'Contribution not found' using errcode = 'P0002'; end if;

  -- Same lock order as record_contribution: the request row first, then the entry.
  select * into v_request from public.requests where id = v_request_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  select * into v_entry from public.contributions where id = p_entry_id for update;

  if v_entry.status not in ('sent', 'not_received') then
    raise exception 'Only a payment still waiting can be settled' using errcode = '55000';
  end if;
  if p_actor_id = v_entry.contributor_id or p_actor_id = v_request.borrower_id then
    raise exception 'You are part of this payment, so someone else must settle it' using errcode = '42501';
  end if;

  perform set_config('app.financial_actor_id', p_actor_id::text, true);
  if p_action = 'remove' then
    update public.contributions
       set status = 'removed', updated_at = v_at, settled_by = p_actor_id, settled_note = p_note, settled_at = v_at
     where id = p_entry_id
     returning * into v_entry;
    return to_jsonb(v_entry);
  end if;

  -- A not_received entry is not in the totals, so confirming it counts as new money.
  select coalesce(sum(amount_cents), 0) into v_reserved from public.contributions
   where request_id = v_request_id and id <> p_entry_id and status in ('sent', 'confirmed');
  if v_reserved + v_entry.amount_cents > v_request.principal_cents then
    raise exception 'Only % paise is still needed', greatest(0, v_request.principal_cents - v_reserved) using errcode = '23514';
  end if;

  update public.contributions
     set status = 'confirmed', confirmed_at = v_at, updated_at = v_at,
         settled_by = p_actor_id, settled_note = p_note, settled_at = v_at
   where id = p_entry_id
   returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

create or replace function public.settle_repayment(
  p_entry_id bigint,
  p_actor_id bigint,
  p_action text,
  p_note text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request_id bigint;
  v_request public.requests%rowtype;
  v_entry public.repayments%rowtype;
  v_lent bigint;
  v_reserved bigint;
  v_at timestamptz := coalesce(p_at, now());
begin
  if p_action is null or p_action not in ('confirm', 'remove') then
    raise exception 'Choose confirm or remove' using errcode = '22023';
  end if;
  select request_id into v_request_id from public.repayments where id = p_entry_id;
  if not found then raise exception 'Repayment not found' using errcode = 'P0002'; end if;

  -- Same lock order as record_repayment: the request row first, then the entry.
  select * into v_request from public.requests where id = v_request_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  select * into v_entry from public.repayments where id = p_entry_id for update;

  if v_entry.status not in ('sent', 'not_received') then
    raise exception 'Only a payment still waiting can be settled' using errcode = '55000';
  end if;
  if p_actor_id = v_entry.payer_id or p_actor_id = v_entry.lender_id then
    raise exception 'You are part of this payment, so someone else must settle it' using errcode = '42501';
  end if;

  perform set_config('app.financial_actor_id', p_actor_id::text, true);
  if p_action = 'remove' then
    update public.repayments
       set status = 'removed', updated_at = v_at, settled_by = p_actor_id, settled_note = p_note, settled_at = v_at
     where id = p_entry_id
     returning * into v_entry;
    return to_jsonb(v_entry);
  end if;

  -- What this lender confirmed lending, minus the other repayments to them that are sent or confirmed (the same
  -- reservation record_repayment and the app use).
  select coalesce(sum(amount_cents), 0) into v_lent from public.contributions
   where request_id = v_request_id and contributor_id = v_entry.lender_id and status = 'confirmed';
  select coalesce(sum(amount_cents), 0) into v_reserved from public.repayments
   where request_id = v_request_id and lender_id = v_entry.lender_id and id <> p_entry_id and status in ('sent', 'confirmed');
  if v_reserved + v_entry.amount_cents > v_lent then
    raise exception 'Only % paise can still be repaid to this lender', greatest(0, v_lent - v_reserved) using errcode = '23514';
  end if;

  update public.repayments
     set status = 'confirmed', confirmed_at = v_at, updated_at = v_at,
         settled_by = p_actor_id, settled_note = p_note, settled_at = v_at
   where id = p_entry_id
   returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

revoke execute on function public.settle_contribution(bigint, bigint, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.settle_repayment(bigint, bigint, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.settle_contribution(bigint, bigint, text, text, timestamptz) to service_role;
grant execute on function public.settle_repayment(bigint, bigint, text, text, timestamptz) to service_role;

-- Removed rows release their UTR (replaces the 0008 predicate `where utr is not null`).
drop index if exists public.contributions_request_utr_key;
create unique index if not exists contributions_request_utr_key
  on public.contributions (request_id, upper(utr))
  where utr is not null and status <> 'removed';

drop index if exists public.repayments_request_utr_key;
create unique index if not exists repayments_request_utr_key
  on public.repayments (request_id, upper(utr))
  where utr is not null and status <> 'removed';

commit;
