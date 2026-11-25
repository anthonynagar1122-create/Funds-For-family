-- Contributions are recorded in one transaction that locks the request row, so two concurrent
-- contributions cannot both pass the funding cap. A client may send an idempotency key; a retry with the
-- same key returns the original contribution instead of recording a second one.

alter table public.contributions add column if not exists idempotency_key text
  check (idempotency_key is null or char_length(idempotency_key) between 8 and 100);
create unique index if not exists contributions_idempotency_idx
  on public.contributions (contributor_id, idempotency_key) where idempotency_key is not null;

create or replace function public.add_contribution(
  p_request_id       bigint,
  p_contributor_id   bigint,
  p_amount_cents     integer,
  p_idempotency_key  text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r         public.requests%rowtype;
  raised    integer;
  c_id      bigint;
  did_fund  boolean := false;
begin
  -- Lock the request first: every contribution to it is serialised here.
  select * into r from public.requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_idempotency_key is not null then
    select id into c_id from public.contributions
      where contributor_id = p_contributor_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'contribution_id', c_id);
    end if;
  end if;

  if r.borrower_id = p_contributor_id then
    return jsonb_build_object('ok', false, 'reason', 'own_request');
  end if;
  if r.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;

  select coalesce(sum(amount_cents), 0) into raised from public.contributions where request_id = p_request_id;
  if p_amount_cents > r.principal_cents - raised then
    return jsonb_build_object('ok', false, 'reason', 'over_cap',
      'remaining_cents', greatest(0, r.principal_cents - raised));
  end if;

  insert into public.contributions (request_id, contributor_id, amount_cents, idempotency_key)
    values (p_request_id, p_contributor_id, p_amount_cents, p_idempotency_key)
    returning id into c_id;

  if raised + p_amount_cents >= r.principal_cents then
    update public.requests set status = 'funded', funded_at = now() where id = p_request_id;
    did_fund := true;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'contribution_id', c_id, 'funded', did_fund);
end;
$$;

-- Only the server (service_role) may call it.
revoke all on function public.add_contribution(bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.add_contribution(bigint, bigint, integer, text) to service_role;
