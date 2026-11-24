-- Atomic financial writes for Funds For Family.
-- All money is integer paise. Functions run as INVOKER and are callable only by the server service_role.

begin;

create table if not exists public.financial_idempotency (
  operation text not null check (operation in ('contribution.create','repayment.create')),
  actor_id bigint not null references public.users(id),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (operation, actor_id, idempotency_key)
);

create table if not exists public.financial_audit_events (
  id bigint generated always as identity primary key,
  request_id bigint not null references public.requests(id),
  entry_type text not null check (entry_type in ('contribution','repayment')),
  entry_id bigint not null,
  event_type text not null,
  actor_id bigint references public.users(id),
  idempotency_key text,
  amount_cents integer not null check (amount_cents > 0),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists financial_audit_request_idx on public.financial_audit_events (request_id, id);
create index if not exists financial_audit_entry_idx on public.financial_audit_events (entry_type, entry_id, id);

alter table public.financial_idempotency enable row level security;
alter table public.financial_audit_events enable row level security;
revoke all on public.financial_idempotency, public.financial_audit_events from anon, authenticated;
grant all on public.financial_idempotency, public.financial_audit_events to service_role;
grant usage, select on sequence public.financial_audit_events_id_seq to service_role;

create or replace function public.reject_financial_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'financial audit events are append-only' using errcode = '55000';
end;
$$;
revoke all on function public.reject_financial_audit_mutation() from public, anon, authenticated;

drop trigger if exists financial_audit_append_only on public.financial_audit_events;
create trigger financial_audit_append_only
before update or delete on public.financial_audit_events
for each row execute function public.reject_financial_audit_mutation();

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
      'operation', tg_op
    )
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.capture_financial_ledger_event() from public, anon, authenticated;

drop trigger if exists contributions_financial_audit on public.contributions;
create trigger contributions_financial_audit
after insert or update or delete on public.contributions
for each row execute function public.capture_financial_ledger_event();
drop trigger if exists repayments_financial_audit on public.repayments;
create trigger repayments_financial_audit
after insert or update or delete on public.repayments
for each row execute function public.capture_financial_ledger_event();

create or replace function public.record_contribution(
  p_request_id bigint,
  p_contributor_id bigint,
  p_amount_cents integer,
  p_utr text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request public.requests%rowtype;
  v_entry public.contributions%rowtype;
  v_hash text;
  v_saved_hash text;
  v_saved_response jsonb;
  v_inserted integer;
  v_reserved bigint;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128 then
    raise exception 'A valid idempotency key is required' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Contribution must be a positive amount' using errcode = 'P0001';
  end if;
  if p_utr is not null and p_utr !~ '^[A-Za-z0-9]{6,35}$' then
    raise exception 'A UPI reference is 6 to 35 letters or digits' using errcode = 'P0001';
  end if;
  v_hash := md5(jsonb_build_object('request_id',p_request_id,'contributor_id',p_contributor_id,'amount_cents',p_amount_cents,'utr',p_utr)::text);
  insert into public.financial_idempotency(operation,actor_id,idempotency_key,request_hash)
  values ('contribution.create',p_contributor_id,p_idempotency_key,v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select request_hash,response into v_saved_hash,v_saved_response from public.financial_idempotency
    where operation='contribution.create' and actor_id=p_contributor_id and idempotency_key=p_idempotency_key;
    if v_saved_hash is distinct from v_hash then
      raise exception 'This idempotency key was already used for a different contribution' using errcode = '22023';
    end if;
    if v_saved_response is null then raise exception 'The original contribution is still processing; retry shortly' using errcode = 'P0001'; end if;
    return v_saved_response;
  end if;

  select * into v_request from public.requests where id=p_request_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0001'; end if;
  if v_request.status <> 'open' then raise exception 'This request is not accepting contributions' using errcode = 'P0001'; end if;
  if p_contributor_id = v_request.borrower_id then raise exception 'You cannot fund your own request' using errcode = 'P0001'; end if;
  if not exists (
    select 1 from public.follows f1 join public.follows f2
      on f2.follower_id=f1.followee_id and f2.followee_id=f1.follower_id
    where f1.follower_id=p_contributor_id and f1.followee_id=v_request.borrower_id
  ) then raise exception 'Only mutual connections can fund this request' using errcode = 'P0001'; end if;

  select coalesce(sum(amount_cents),0) into v_reserved from public.contributions
    where request_id=p_request_id and status in ('sent','confirmed');
  if v_reserved + p_amount_cents > v_request.principal_cents then
    raise exception 'Only % paise is still needed', greatest(0,v_request.principal_cents-v_reserved) using errcode = 'P0001';
  end if;

  perform set_config('app.financial_actor_id',p_contributor_id::text,true);
  perform set_config('app.financial_idempotency_key',p_idempotency_key,true);
  insert into public.contributions(request_id,contributor_id,amount_cents,utr,status,created_at)
    values(p_request_id,p_contributor_id,p_amount_cents,p_utr,'sent',now()) returning * into v_entry;
  v_saved_response := to_jsonb(v_entry);
  update public.financial_idempotency set response=v_saved_response
    where operation='contribution.create' and actor_id=p_contributor_id and idempotency_key=p_idempotency_key;
  return v_saved_response;
end;
$$;

create or replace function public.record_repayment(
  p_request_id bigint,
  p_payer_id bigint,
  p_lender_id bigint,
  p_amount_cents integer,
  p_utr text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request public.requests%rowtype;
  v_entry public.repayments%rowtype;
  v_hash text;
  v_saved_hash text;
  v_saved_response jsonb;
  v_inserted integer;
  v_lent bigint;
  v_reserved bigint;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128 then
    raise exception 'A valid idempotency key is required' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Repayment must be a positive amount' using errcode = 'P0001';
  end if;
  if p_utr is not null and p_utr !~ '^[A-Za-z0-9]{6,35}$' then
    raise exception 'A UPI reference is 6 to 35 letters or digits' using errcode = 'P0001';
  end if;
  v_hash := md5(jsonb_build_object('request_id',p_request_id,'payer_id',p_payer_id,'lender_id',p_lender_id,'amount_cents',p_amount_cents,'utr',p_utr)::text);
  insert into public.financial_idempotency(operation,actor_id,idempotency_key,request_hash)
  values ('repayment.create',p_payer_id,p_idempotency_key,v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select request_hash,response into v_saved_hash,v_saved_response from public.financial_idempotency
    where operation='repayment.create' and actor_id=p_payer_id and idempotency_key=p_idempotency_key;
    if v_saved_hash is distinct from v_hash then
      raise exception 'This idempotency key was already used for a different repayment' using errcode = '22023';
    end if;
    if v_saved_response is null then raise exception 'The original repayment is still processing; retry shortly' using errcode = 'P0001'; end if;
    return v_saved_response;
  end if;

  select * into v_request from public.requests where id=p_request_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0001'; end if;
  if v_request.status <> 'funded' then raise exception 'Repayments can be recorded only for funded requests' using errcode = 'P0001'; end if;
  if p_payer_id <> v_request.borrower_id and p_payer_id <> v_request.nominee_id then
    raise exception 'Only the borrower or trusted contact can record a repayment' using errcode = 'P0001';
  end if;
  if p_lender_id is null or p_lender_id=p_payer_id then raise exception 'Choose a valid lender' using errcode = 'P0001'; end if;
  select coalesce(sum(amount_cents),0) into v_lent from public.contributions
    where request_id=p_request_id and contributor_id=p_lender_id and status='confirmed';
  select coalesce(sum(amount_cents),0) into v_reserved from public.repayments
    where request_id=p_request_id and lender_id=p_lender_id and status in ('sent','confirmed');
  if v_lent = 0 then raise exception 'Unknown lender' using errcode = 'P0001'; end if;
  if v_reserved + p_amount_cents > v_lent then
    raise exception 'Only % paise can still be repaid to this lender', greatest(0,v_lent-v_reserved) using errcode = 'P0001';
  end if;

  perform set_config('app.financial_actor_id',p_payer_id::text,true);
  perform set_config('app.financial_idempotency_key',p_idempotency_key,true);
  insert into public.repayments(request_id,payer_id,lender_id,amount_cents,utr,status,created_at)
    values(p_request_id,p_payer_id,p_lender_id,p_amount_cents,p_utr,'sent',now()) returning * into v_entry;
  v_saved_response := to_jsonb(v_entry);
  update public.financial_idempotency set response=v_saved_response
    where operation='repayment.create' and actor_id=p_payer_id and idempotency_key=p_idempotency_key;
  return v_saved_response;
end;
$$;

create or replace function public.revise_contribution(
  p_entry_id bigint, p_actor_id bigint, p_amount_cents integer, p_utr text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entry public.contributions%rowtype;
  v_request public.requests%rowtype;
  v_reserved bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Contribution must be a positive amount' using errcode='P0001'; end if;
  if p_utr is not null and p_utr !~ '^[A-Za-z0-9]{6,35}$' then raise exception 'A UPI reference is 6 to 35 letters or digits' using errcode='P0001'; end if;
  select * into v_entry from public.contributions where id=p_entry_id;
  if not found then raise exception 'Contribution not found' using errcode='P0001'; end if;
  select * into v_request from public.requests where id=v_entry.request_id for update;
  select * into v_entry from public.contributions where id=p_entry_id for update;
  if v_entry.contributor_id <> p_actor_id then raise exception 'Only the person who sent this can change it' using errcode='P0001'; end if;
  if v_entry.status <> 'not_received' then raise exception 'You can correct an entry only after the borrower marked it not received' using errcode='P0001'; end if;
  if v_request.status <> 'open' then raise exception 'This request is not accepting contributions' using errcode='P0001'; end if;
  select coalesce(sum(amount_cents),0) into v_reserved from public.contributions
    where request_id=v_request.id and id<>p_entry_id and status in ('sent','confirmed');
  if v_reserved+p_amount_cents>v_request.principal_cents then
    raise exception 'Only % paise is still needed', greatest(0,v_request.principal_cents-v_reserved) using errcode='P0001';
  end if;
  perform set_config('app.financial_actor_id',p_actor_id::text,true);
  update public.contributions set amount_cents=p_amount_cents, utr=p_utr, status='sent', updated_at=now()
    where id=p_entry_id returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

create or replace function public.revise_repayment(
  p_entry_id bigint, p_actor_id bigint, p_amount_cents integer, p_utr text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entry public.repayments%rowtype;
  v_request public.requests%rowtype;
  v_lent bigint;
  v_reserved bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Repayment must be a positive amount' using errcode='P0001'; end if;
  if p_utr is not null and p_utr !~ '^[A-Za-z0-9]{6,35}$' then raise exception 'A UPI reference is 6 to 35 letters or digits' using errcode='P0001'; end if;
  select * into v_entry from public.repayments where id=p_entry_id;
  if not found then raise exception 'Repayment not found' using errcode='P0001'; end if;
  select * into v_request from public.requests where id=v_entry.request_id for update;
  select * into v_entry from public.repayments where id=p_entry_id for update;
  if v_entry.payer_id <> p_actor_id then raise exception 'Only the person who sent this can change it' using errcode='P0001'; end if;
  if v_entry.status <> 'not_received' then raise exception 'You can correct a repayment only after it was marked not received' using errcode='P0001'; end if;
  if v_request.status <> 'funded' then raise exception 'This request is not in repayment' using errcode='P0001'; end if;
  select coalesce(sum(amount_cents),0) into v_lent from public.contributions
    where request_id=v_request.id and contributor_id=v_entry.lender_id and status='confirmed';
  select coalesce(sum(amount_cents),0) into v_reserved from public.repayments
    where request_id=v_request.id and lender_id=v_entry.lender_id and id<>p_entry_id and status in ('sent','confirmed');
  if v_lent=0 then raise exception 'Unknown lender' using errcode='P0001'; end if;
  if v_reserved+p_amount_cents>v_lent then
    raise exception 'Only % paise can still be repaid to this lender', greatest(0,v_lent-v_reserved) using errcode='P0001';
  end if;
  perform set_config('app.financial_actor_id',p_actor_id::text,true);
  update public.repayments set amount_cents=p_amount_cents, utr=p_utr, status='sent', updated_at=now()
    where id=p_entry_id returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

revoke all on function public.record_contribution(bigint,bigint,integer,text,text) from public, anon, authenticated;
revoke all on function public.record_repayment(bigint,bigint,bigint,integer,text,text) from public, anon, authenticated;
revoke all on function public.revise_contribution(bigint,bigint,integer,text) from public, anon, authenticated;
revoke all on function public.revise_repayment(bigint,bigint,integer,text) from public, anon, authenticated;
grant execute on function public.record_contribution(bigint,bigint,integer,text,text) to service_role;
grant execute on function public.record_repayment(bigint,bigint,bigint,integer,text,text) to service_role;
grant execute on function public.revise_contribution(bigint,bigint,integer,text) to service_role;
grant execute on function public.revise_repayment(bigint,bigint,integer,text) to service_role;

commit;
