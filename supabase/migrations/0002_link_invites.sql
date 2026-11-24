-- Shareable invite links: an invite can be created without an email address
-- (shared through WhatsApp, SMS, etc.). Accepting a link connects inviter and invitee both ways.
alter table public.invites alter column email drop not null;
create index if not exists invites_inviter_idx on public.invites (inviter_id);
