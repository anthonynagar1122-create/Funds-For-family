-- Funds For Family: migration 0002, customer ready.
-- NOTE: every column named *_cents holds PAISE (1/100 rupee), not rupees and not cents.
-- Additive and re-runnable: new columns use "if not exists"; the only constraint recreated is requests_status_check.
-- Apply to staging first. Production only at the owner-approved release.

-- users
alter table public.users add column if not exists avatar_url        text;
alter table public.users add column if not exists email_reminders   boolean not null default true;
alter table public.users add column if not exists email_thanks      boolean not null default true;
alter table public.users add column if not exists upi_id            text;
alter table public.users add column if not exists is_admin          boolean not null default false;
alter table public.users add column if not exists invite_limit      integer;
alter table public.users add column if not exists welcomed_at       timestamptz;
alter table public.users add column if not exists terms_accepted_at timestamptz;
alter table public.users add column if not exists deleted_at        timestamptz;
alter table public.users drop constraint if exists users_upi_id_check;
alter table public.users add constraint users_upi_id_check
  check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$');

-- invites: new rows store only the SHA-256 hash of the token
alter table public.invites alter column token drop not null;
alter table public.invites add column if not exists token_hash       text;
alter table public.invites add column if not exists expires_at       timestamptz not null default (now() + interval '14 days');
alter table public.invites add column if not exists revoked_at       timestamptz;
alter table public.invites add column if not exists superseded_at    timestamptz;
alter table public.invites add column if not exists accepted_user_id bigint references public.users(id);
create unique index if not exists invites_token_hash_key on public.invites (token_hash);
create index if not exists invites_inviter_idx on public.invites (inviter_id);
create index if not exists invites_accepted_user_idx on public.invites (accepted_user_id);
create index if not exists invites_email_lower_idx on public.invites (lower(email));

-- requests
alter table public.requests add column if not exists funded_cents            integer;
alter table public.requests add column if not exists original_repayment_date date;
alter table public.requests add column if not exists withdrawn_at            timestamptz;
alter table public.requests add column if not exists contact_decided_at      timestamptz;
alter table public.requests add column if not exists category                text;
alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status in ('awaiting_contact','contact_declined','pending_verification','rejected','open','funded','repaid','withdrawn'));
alter table public.requests drop constraint if exists requests_category_check;
alter table public.requests add constraint requests_category_check
  check (category is null or category in ('education','medical','home','family_event','work','emergency','other'));
alter table public.requests drop constraint if exists requests_principal_range_check;
alter table public.requests add constraint requests_principal_range_check
  check (principal_cents between 10000 and 5000000) not valid;
create unique index if not exists requests_one_active_per_borrower on public.requests (borrower_id)
  where status in ('awaiting_contact','contact_declined','pending_verification','open','funded');
create index if not exists requests_nominee_idx on public.requests (nominee_id);

-- contributions: old rows backfill as confirmed; the app inserts 'sent'
alter table public.contributions add column if not exists status text not null default 'confirmed';
alter table public.contributions drop constraint if exists contributions_status_check;
alter table public.contributions add constraint contributions_status_check
  check (status in ('sent','confirmed','not_received'));
alter table public.contributions add column if not exists utr                text;
alter table public.contributions add column if not exists confirmed_at       timestamptz;
alter table public.contributions add column if not exists updated_at         timestamptz;
alter table public.contributions add column if not exists settled_by         bigint references public.users(id);
alter table public.contributions add column if not exists settled_note       text;
alter table public.contributions add column if not exists settled_at         timestamptz;
alter table public.contributions add column if not exists help_requested_at  timestamptz;
create index if not exists contributions_contributor_idx on public.contributions (contributor_id);
create index if not exists contributions_settled_by_idx on public.contributions (settled_by);

-- repayments: lender_id stays nullable for old rows; the app requires it on new rows
alter table public.repayments add column if not exists lender_id           bigint references public.users(id);
alter table public.repayments add column if not exists status              text not null default 'confirmed';
alter table public.repayments drop constraint if exists repayments_status_check;
alter table public.repayments add constraint repayments_status_check
  check (status in ('sent','confirmed','not_received'));
alter table public.repayments add column if not exists utr                 text;
alter table public.repayments add column if not exists confirmed_at        timestamptz;
alter table public.repayments add column if not exists updated_at          timestamptz;
alter table public.repayments add column if not exists settled_by          bigint references public.users(id);
alter table public.repayments add column if not exists settled_note        text;
alter table public.repayments add column if not exists settled_at          timestamptz;
alter table public.repayments add column if not exists help_requested_at   timestamptz;
create index if not exists repayments_payer_idx on public.repayments (payer_id);
create index if not exists repayments_lender_idx on public.repayments (lender_id);
create index if not exists repayments_settled_by_idx on public.repayments (settled_by);

-- verifications: index the verifier foreign key
create index if not exists verifications_verifier_idx on public.verifications (verifier_id);

-- Phase C tables
create table if not exists public.date_changes (
  id             bigint generated always as identity primary key,
  request_id     bigint not null references public.requests(id) on delete cascade,
  proposed_date  date not null,
  status         text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);
create index if not exists date_changes_request_idx on public.date_changes (request_id);

create table if not exists public.date_change_votes (
  date_change_id  bigint not null references public.date_changes(id) on delete cascade,
  lender_id       bigint not null references public.users(id),
  decision        text not null check (decision in ('accept','decline')),
  created_at      timestamptz not null default now(),
  primary key (date_change_id, lender_id)
);
create index if not exists date_change_votes_lender_idx on public.date_change_votes (lender_id);

create table if not exists public.help_messages (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references public.users(id),
  body         text not null check (char_length(body) between 10 and 2000),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index if not exists help_messages_user_idx on public.help_messages (user_id);

create table if not exists public.notes (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.requests(id) on delete cascade,
  author_id   bigint not null references public.users(id),
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index if not exists notes_request_idx on public.notes (request_id);
create index if not exists notes_author_idx on public.notes (author_id);

create table if not exists public.notifications_sent (
  request_id    bigint not null references public.requests(id) on delete cascade,
  kind          text not null,
  recipient_id  bigint not null references public.users(id),
  sent_on       date not null,
  primary key (request_id, kind, recipient_id, sent_on)
);
create index if not exists notifications_sent_recipient_idx on public.notifications_sent (recipient_id);

-- Lock down the new tables from the Data API roles (same pattern as 0001).
alter table public.date_changes        enable row level security;
alter table public.date_change_votes   enable row level security;
alter table public.help_messages       enable row level security;
alter table public.notes               enable row level security;
alter table public.notifications_sent  enable row level security;
revoke all on public.date_changes, public.date_change_votes, public.help_messages,
              public.notes, public.notifications_sent
  from anon, authenticated;
