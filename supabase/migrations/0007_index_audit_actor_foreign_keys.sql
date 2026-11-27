-- Cover foreign keys introduced by admin, support, and financial audit workflows.
-- These indexes support actor lookups and efficient FK checks on user deletion/update.
create index if not exists admin_audit_events_actor_idx
  on public.admin_audit_events (actor_id);
create index if not exists support_audit_events_actor_idx
  on public.support_audit_events (actor_id);
create index if not exists help_messages_assigned_by_idx
  on public.help_messages (assigned_by);
create index if not exists financial_audit_events_actor_idx
  on public.financial_audit_events (actor_id);
create index if not exists financial_idempotency_actor_idx
  on public.financial_idempotency (actor_id);
