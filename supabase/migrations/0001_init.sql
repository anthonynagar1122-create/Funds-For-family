-- Funds For Family: initial schema.
-- Access model: the Vercel API uses the Supabase SERVICE ROLE key (server-only). Row Level Security
-- is enabled on every table with NO policies for anon/authenticated, so the public Data API cannot
-- read or write these tables. Add narrow policies later only if the browser must query Supabase directly.

create table if not exists public.users (
  id           bigint generated always as identity primary key,
  clerk_id     text not null unique,
  name         text not null check (char_length(name) between 1 and 120),
  email        text not null check (position('@' in email) > 1),
  is_verifier  boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index if not exists users_email_lower_idx on public.users (lower(email));

create table if not exists public.follows (
  follower_id  bigint not null references public.users(id) on delete cascade,
  followee_id  bigint not null references public.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

create table if not exists public.invites (
  id           bigint generated always as identity primary key,
  inviter_id   bigint not null references public.users(id) on delete cascade,
  email        text not null,
  token        text not null unique,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz
);

create table if not exists public.requests (
  id               bigint generated always as identity primary key,
  borrower_id      bigint not null references public.users(id),
  nominee_id       bigint not null references public.users(id),
  purpose          text not null check (char_length(purpose) >= 20),
  principal_cents  integer not null check (principal_cents > 0),
  repayment_date   date not null,
  status           text not null default 'pending_verification'
                   check (status in ('pending_verification','rejected','open','funded','repaid')),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  funded_at        timestamptz,
  repaid_at        timestamptz,
  check (nominee_id <> borrower_id)
);
create index if not exists requests_borrower_idx on public.requests (borrower_id);
create index if not exists requests_status_idx on public.requests (status);

create table if not exists public.verifications (
  request_id   bigint not null references public.requests(id) on delete cascade,
  verifier_id  bigint not null references public.users(id),
  decision     text not null check (decision in ('approve','reject')),
  note         text not null default '' check (char_length(note) <= 1000),
  created_at   timestamptz not null default now(),
  primary key (request_id, verifier_id)
);

create table if not exists public.contributions (
  id              bigint generated always as identity primary key,
  request_id      bigint not null references public.requests(id) on delete cascade,
  contributor_id  bigint not null references public.users(id),
  amount_cents    integer not null check (amount_cents > 0),
  created_at      timestamptz not null default now()
);
create index if not exists contributions_request_idx on public.contributions (request_id);

create table if not exists public.repayments (
  id            bigint generated always as identity primary key,
  request_id    bigint not null references public.requests(id) on delete cascade,
  payer_id      bigint not null references public.users(id),
  amount_cents  integer not null check (amount_cents > 0),
  created_at    timestamptz not null default now()
);
create index if not exists repayments_request_idx on public.repayments (request_id);

-- Lock everything down from the Data API roles. The server uses service_role, which bypasses RLS.
alter table public.users          enable row level security;
alter table public.follows        enable row level security;
alter table public.invites        enable row level security;
alter table public.requests       enable row level security;
alter table public.verifications  enable row level security;
alter table public.contributions  enable row level security;
alter table public.repayments     enable row level security;

revoke all on public.users, public.follows, public.invites, public.requests,
              public.verifications, public.contributions, public.repayments
  from anon, authenticated;
