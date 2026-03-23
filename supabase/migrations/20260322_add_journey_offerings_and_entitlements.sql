create table if not exists public.journey_offerings (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('preset', 'custom')),
  source_id text not null,
  slug text not null unique,
  title text not null,
  creator_label text,
  cover_image_url text,
  teaser_description text,
  duration_minutes int,
  stop_count int,
  first_stop_title text,
  pricing_status text not null check (pricing_status in ('free', 'paid', 'tbd')),
  price_usd_cents int,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_kind, source_id),
  constraint journey_offerings_price_required_for_paid_check
    check (pricing_status <> 'paid' or price_usd_cents is not null)
);

create table if not exists public.journey_entitlements (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.journey_offerings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  purchaser_email text not null,
  status text not null default 'active' check (status in ('active', 'refunded', 'revoked')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offering_id, user_id)
);

create table if not exists public.stripe_webhook_events (
  id bigint generated always as identity primary key,
  stripe_event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_journey_offerings_slug on public.journey_offerings(slug);
create index if not exists idx_journey_offerings_source on public.journey_offerings(source_kind, source_id);
create index if not exists idx_journey_entitlements_user on public.journey_entitlements(user_id, created_at desc);
create index if not exists idx_journey_entitlements_offering on public.journey_entitlements(offering_id, status);

drop trigger if exists trg_journey_offerings_updated_at on public.journey_offerings;
create trigger trg_journey_offerings_updated_at
before update on public.journey_offerings
for each row execute function public.set_updated_at();

drop trigger if exists trg_journey_entitlements_updated_at on public.journey_entitlements;
create trigger trg_journey_entitlements_updated_at
before update on public.journey_entitlements
for each row execute function public.set_updated_at();

alter table public.journey_offerings enable row level security;
alter table public.journey_entitlements enable row level security;
alter table public.stripe_webhook_events enable row level security;

drop policy if exists journey_offerings_public_select on public.journey_offerings;
create policy journey_offerings_public_select
on public.journey_offerings
for select
to anon, authenticated
using (published = true);

drop policy if exists journey_entitlements_select_own on public.journey_entitlements;
create policy journey_entitlements_select_own
on public.journey_entitlements
for select
to authenticated
using (auth.uid() = user_id);
