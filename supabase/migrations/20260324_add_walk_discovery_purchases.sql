create table if not exists public.walk_discovery_purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_key text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  jam_id uuid not null references public.jams(id) on delete cascade,
  candidate_key text not null,
  candidate_title text not null,
  purchaser_email text not null,
  amount_usd_cents int not null check (amount_usd_cents >= 0),
  status text not null default 'active' check (status in ('active', 'refunded', 'revoked')),
  stripe_checkout_session_id text not null unique,
  route_id text,
  inserted_stop_id text,
  inserted_stop_index int,
  source text,
  distance_meters double precision,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_walk_discovery_purchases_user
on public.walk_discovery_purchases(user_id, created_at desc);

create index if not exists idx_walk_discovery_purchases_jam
on public.walk_discovery_purchases(jam_id, created_at desc);

drop trigger if exists trg_walk_discovery_purchases_updated_at on public.walk_discovery_purchases;
create trigger trg_walk_discovery_purchases_updated_at
before update on public.walk_discovery_purchases
for each row execute function public.set_updated_at();

alter table public.walk_discovery_purchases enable row level security;

drop policy if exists walk_discovery_purchases_select_own on public.walk_discovery_purchases;
create policy walk_discovery_purchases_select_own
on public.walk_discovery_purchases
for select
to authenticated
using (auth.uid() = user_id);
