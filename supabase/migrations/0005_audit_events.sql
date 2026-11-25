-- Audit trail for sensitive actions: who did what, to which record, when, and from which IP.
-- Written only by the server (service_role, which bypasses RLS). The browser has no access.

create table if not exists public.audit_events (
  id            bigint generated always as identity primary key,
  actor_id      bigint references public.users(id) on delete set null,
  action        text not null check (char_length(action) between 1 and 64),
  subject_type  text check (subject_type is null or char_length(subject_type) <= 32),
  subject_id    text check (subject_id is null or char_length(subject_id) <= 64),
  detail        text check (detail is null or char_length(detail) <= 200),
  ip            text check (ip is null or char_length(ip) <= 64),
  created_at    timestamptz not null default now()
);
create index if not exists audit_events_actor_idx on public.audit_events (actor_id, created_at);
create index if not exists audit_events_subject_idx on public.audit_events (subject_type, subject_id);

alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon, authenticated;
