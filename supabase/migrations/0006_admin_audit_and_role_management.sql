-- Audited server-side member role management for the restricted Admin workspace.
begin;

create table if not exists public.admin_audit_events (
  id bigint generated always as identity primary key,
  actor_id bigint not null references public.users(id),
  target_user_id bigint not null references public.users(id),
  event_type text not null check (event_type in ('member.roles_updated')),
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_events_created_idx on public.admin_audit_events (created_at desc, id desc);
create index if not exists admin_audit_events_target_idx on public.admin_audit_events (target_user_id, id desc);
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_audit_events from anon, authenticated;
grant all on public.admin_audit_events to service_role;
grant usage, select on sequence public.admin_audit_events_id_seq to service_role;

create or replace function public.reject_admin_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'admin audit events are append-only' using errcode = '55000';
end;
$$;
revoke all on function public.reject_admin_audit_mutation() from public, anon, authenticated;
drop trigger if exists admin_audit_append_only on public.admin_audit_events;
create trigger admin_audit_append_only
before update or delete on public.admin_audit_events
for each row execute function public.reject_admin_audit_mutation();
drop trigger if exists admin_audit_no_truncate on public.admin_audit_events;
create trigger admin_audit_no_truncate
before truncate on public.admin_audit_events
for each statement execute function public.reject_admin_audit_mutation();

create or replace function public.admin_set_member_roles(
  p_actor_id bigint,
  p_target_user_id bigint,
  p_is_admin boolean,
  p_is_verifier boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_admin_count bigint;
begin
  if not exists (select 1 from public.users where id=p_actor_id and is_admin=true and deleted_at is null) then
    raise exception 'Admins only' using errcode='42501';
  end if;
  -- Serialize role changes so two admins cannot concurrently remove the final administrator.
  perform 1 from public.users where is_admin=true and deleted_at is null order by id for update;
  select count(*) into v_admin_count from public.users where is_admin=true and deleted_at is null;
  select jsonb_build_object('is_admin',is_admin,'is_verifier',is_verifier) into v_before
    from public.users where id=p_target_user_id and deleted_at is null for update;
  if v_before is null then raise exception 'Member not found' using errcode='P0002'; end if;
  if (v_before->>'is_admin')::boolean and not p_is_admin and v_admin_count <= 1 then
    raise exception 'The last administrator cannot be removed' using errcode='23514';
  end if;
  update public.users set is_admin=p_is_admin, is_verifier=p_is_verifier
    where id=p_target_user_id and deleted_at is null
    returning jsonb_build_object('id',id,'name',name,'email',email,'is_admin',is_admin,'is_verifier',is_verifier) into v_after;
  insert into public.admin_audit_events(actor_id,target_user_id,event_type,before_state,after_state)
    values(p_actor_id,p_target_user_id,'member.roles_updated',v_before,
      jsonb_build_object('is_admin',p_is_admin,'is_verifier',p_is_verifier));
  return v_after;
end;
$$;
revoke all on function public.admin_set_member_roles(bigint,bigint,boolean,boolean) from public, anon, authenticated;
grant execute on function public.admin_set_member_roles(bigint,bigint,boolean,boolean) to service_role;

-- Support assignment is limited to administrators/verifiers and is audited in the same transaction.
alter table public.help_messages
  add column if not exists assigned_to bigint references public.users(id),
  add column if not exists assigned_by bigint references public.users(id),
  add column if not exists assigned_at timestamptz;
create index if not exists help_messages_assignee_idx on public.help_messages (assigned_to, resolved_at, id desc);

create table if not exists public.support_audit_events (
  id bigint generated always as identity primary key,
  actor_id bigint not null references public.users(id),
  help_message_id bigint not null references public.help_messages(id),
  event_type text not null check (event_type in ('support.assigned','support.unassigned','support.resolved')),
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists support_audit_events_message_idx on public.support_audit_events (help_message_id, id desc);
alter table public.support_audit_events enable row level security;
revoke all on public.support_audit_events from anon, authenticated;
grant all on public.support_audit_events to service_role;
grant usage, select on sequence public.support_audit_events_id_seq to service_role;
drop trigger if exists support_audit_append_only on public.support_audit_events;
create trigger support_audit_append_only
before update or delete or truncate on public.support_audit_events
for each statement execute function public.reject_admin_audit_mutation();

create or replace function public.admin_assign_help_message(
  p_actor_id bigint, p_message_id bigint, p_assignee_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_event text;
begin
  if not exists (select 1 from public.users where id=p_actor_id and is_admin=true and deleted_at is null) then
    raise exception 'Admins only' using errcode='42501';
  end if;
  if p_assignee_id is not null and not exists (
    select 1 from public.users where id=p_assignee_id and deleted_at is null and (is_admin=true or is_verifier=true)
  ) then raise exception 'Assignee must be an active administrator or verifier' using errcode='23514'; end if;
  select jsonb_build_object('assignedTo',assigned_to,'assignedBy',assigned_by,'assignedAt',assigned_at)
    into v_before from public.help_messages where id=p_message_id for update;
  if v_before is null then raise exception 'Support message not found' using errcode='P0002'; end if;
  update public.help_messages set assigned_to=p_assignee_id, assigned_by=p_actor_id,
    assigned_at=case when p_assignee_id is null then null else now() end
    where id=p_message_id
    returning jsonb_build_object('id',id,'userId',user_id,'body',body,'createdAt',created_at,
      'resolvedAt',resolved_at,'assignedTo',assigned_to,'assignedBy',assigned_by,'assignedAt',assigned_at) into v_after;
  v_event := case when p_assignee_id is null then 'support.unassigned' else 'support.assigned' end;
  insert into public.support_audit_events(actor_id,help_message_id,event_type,before_state,after_state)
    values(p_actor_id,p_message_id,v_event,v_before,
      jsonb_build_object('assignedTo',p_assignee_id,'assignedBy',p_actor_id,
        'assignedAt',case when p_assignee_id is null then null else now() end));
  return v_after;
end;
$$;
revoke all on function public.admin_assign_help_message(bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.admin_assign_help_message(bigint,bigint,bigint) to service_role;

create or replace function public.admin_resolve_help_message(p_actor_id bigint,p_message_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_resolved_at timestamptz;
begin
  if not exists (select 1 from public.users where id=p_actor_id and is_admin=true and deleted_at is null) then
    raise exception 'Admins only' using errcode='42501';
  end if;
  select jsonb_build_object('resolvedAt',resolved_at,'assignedTo',assigned_to)
    into v_before from public.help_messages where id=p_message_id for update;
  if v_before is null then raise exception 'Support message not found' using errcode='P0002'; end if;
  v_resolved_at := coalesce((v_before->>'resolvedAt')::timestamptz,now());
  update public.help_messages set resolved_at=v_resolved_at where id=p_message_id and resolved_at is null;
  select jsonb_build_object('id',id,'userId',user_id,'body',body,'createdAt',created_at,
    'resolvedAt',resolved_at,'assignedTo',assigned_to,'assignedBy',assigned_by,'assignedAt',assigned_at)
    into v_after from public.help_messages where id=p_message_id;
  if v_before->>'resolvedAt' is null then
    insert into public.support_audit_events(actor_id,help_message_id,event_type,before_state,after_state)
      values(p_actor_id,p_message_id,'support.resolved',v_before,
        jsonb_build_object('resolvedAt',v_resolved_at,'assignedTo',v_after->'assignedTo'));
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_resolve_help_message(bigint,bigint) from public, anon, authenticated;
grant execute on function public.admin_resolve_help_message(bigint,bigint) to service_role;

commit;
