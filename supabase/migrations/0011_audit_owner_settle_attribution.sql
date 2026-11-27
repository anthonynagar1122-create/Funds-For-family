-- 0011 (P-45 merge): credit owner settlements in the financial audit trail.
-- The owner's settle routes (confirm, or remove with a note; P-34) write contributions/repayments with a plain row
-- update that sets settled_by, settled_note and settled_at. Before this migration the 0005 trigger credited such an
-- update to the borrower (contributions) or the lender (repayments). This replaces the trigger function only; the
-- trigger definitions from 0004 are unchanged. Apply after 0010. Re-runnable (create or replace).
begin;

create or replace function public.capture_financial_ledger_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
  v_request_id bigint;
  v_entry_id bigint;
  v_amount integer;
  v_actor_id bigint;
  v_event text;
  v_entry_type text := case when tg_table_name = 'contributions' then 'contribution' else 'repayment' end;
begin
  if tg_op = 'DELETE' then v_row := to_jsonb(old); else v_row := to_jsonb(new); end if;
  v_request_id := (v_row->>'request_id')::bigint;
  v_entry_id := (v_row->>'id')::bigint;
  v_amount := (v_row->>'amount_cents')::integer;
  v_actor_id := nullif(current_setting('app.financial_actor_id', true), '')::bigint;

  -- Owner settlement (P-34, /admin/*/settle): the update that newly sets settled_by is the owner's action, so it is
  -- credited to settled_by instead of the borrower or lender.
  if v_actor_id is null and tg_op = 'UPDATE' and v_row->>'settled_by' is not null
     and (to_jsonb(old)->>'settled_by') is distinct from (v_row->>'settled_by') then
    v_actor_id := (v_row->>'settled_by')::bigint;
  end if;

  if v_actor_id is null then
    if tg_table_name = 'contributions' then
      if tg_op = 'UPDATE' then
        select borrower_id into v_actor_id from public.requests where id=v_request_id;
      else
        v_actor_id := nullif(v_row->>'contributor_id', '')::bigint;
      end if;
    else
      if tg_op = 'UPDATE' then
        v_actor_id := nullif(v_row->>'lender_id', '')::bigint;
      else
        v_actor_id := nullif(v_row->>'payer_id', '')::bigint;
      end if;
    end if;
  end if;

  v_event := lower(tg_table_name) || '.' || lower(tg_op) || '.' || coalesce(v_row->>'status', 'unknown');
  insert into public.financial_audit_events (
    request_id, entry_type, entry_id, event_type, actor_id, idempotency_key, amount_cents, details
  ) values (
    v_request_id, v_entry_type, v_entry_id, v_event, v_actor_id,
    nullif(current_setting('app.financial_idempotency_key', true), ''),
    greatest(coalesce(v_amount, 1), 1),
    jsonb_build_object(
      'status', v_row->>'status',
      'contributor_id', v_row->>'contributor_id',
      'payer_id', v_row->>'payer_id',
      'lender_id', v_row->>'lender_id',
      'settled_by', v_row->>'settled_by',
      'operation', tg_op
    )
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.capture_financial_ledger_event() from public, anon, authenticated;

commit;
