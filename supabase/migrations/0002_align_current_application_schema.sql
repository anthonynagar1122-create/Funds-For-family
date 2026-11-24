-- Align the deployed database with the current application repository contract.
-- Forward-only and additive. Do not apply to production until reviewed against a preview database.
-- RLS remains enabled. The application accesses Postgres only through the server-side service role.
-- No direct anon/authenticated table access is granted here.

-- Users: profile, preferences and server-managed roles.
alter table public.users
  add column if not exists avatar_url text,
  add column if not exists upi_id text,
  add column if not exists is_admin boolean not null default false,
  add column if not exists invite_limit integer not null default 10,
  add column if not exists email_reminders boolean not null default true,
  add column if not exists email_thanks boolean not null default true,
  add column if not exists welcomed_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists deleted_at timestamptz;

-- Invites: store only a hash of the one-time token in the current application.
alter table public.invites
  add column if not exists token_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists accepted_user_id bigint references public.users(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists superseded_at timestamptz;

update public.invites
set expires_at = created_at + interval '7 days'
where expires_at is null;

alter table public.invites
  alter column expires_at set not null;

create unique index if not exists invites_token_hash_idx
  on public.invites (token_hash)
  where token_hash is not null;

create index if not exists invites_accepted_user_idx
  on public.invites (accepted_user_id);

-- Requests: expand the lifecycle and store the category and settlement summary.
alter table public.requests
  add column if not exists category text,
  add column if not exists original_repayment_date date,
  add column if not exists funded_cents integer not null default 0,
  add column if not exists rejection_reason text,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists contact_decided_at timestamptz;

update public.requests set category = 'other' where category is null;
alter table public.requests alter column category set not null;

alter table public.requests
  drop constraint if exists requests_status_check;

alter table public.requests
  add constraint requests_status_check
  check (status in (
    'awaiting_contact',
    'contact_declined',
    'pending_verification',
    'open',
    'funded',
    'rejected',
    'withdrawn',
    'repaid'
  ));

alter table public.requests
  add constraint requests_category_check
  check (category in ('education', 'medical', 'home', 'family_event', 'work', 'emergency', 'other'));

-- Contributions and repayments: explicit sent/confirmed/not-received states and UPI references.
alter table public.contributions
  add column if not exists status text not null default 'sent',
  add column if not exists utr text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists settled_by bigint references public.users(id),
  add column if not exists settled_note text,
  add column if not exists settled_at timestamptz,
  add column if not exists help_requested_at timestamptz;

alter table public.contributions
  add constraint contributions_status_check
  check (status in ('sent', 'confirmed', 'not_received'));

alter table public.repayments
  add column if not exists lender_id bigint references public.users(id),
  add column if not exists status text not null default 'sent',
  add column if not exists utr text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists settled_by bigint references public.users(id),
  add column if not exists settled_note text,
  add column if not exists settled_at timestamptz,
  add column if not exists help_requested_at timestamptz;

alter table public.repayments
  add constraint repayments_status_check
  check (status in ('sent', 'confirmed', 'not_received'));

-- Member support inbox used by the current server repository.
create table if not exists public.help_messages (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Foreign-key indexes that support joins, member activity and deletion checks.
create index if not exists requests_nominee_idx on public.requests (nominee_id);
create index if not exists contributions_contributor_idx on public.contributions (contributor_id);
create index if not exists repayments_payer_idx on public.repayments (payer_id);
create index if not exists repayments_lender_idx on public.repayments (lender_id);
create index if not exists verifications_verifier_idx on public.verifications (verifier_id);
create index if not exists help_messages_user_created_idx on public.help_messages (user_id, created_at desc);

-- Keep RLS enabled on the new table. No anon/authenticated policy is created:
-- browser access must go through the authenticated application API.
alter table public.help_messages enable row level security;

-- Explicitly preserve the server-only Data API boundary.
revoke all on public.help_messages from anon, authenticated;
