create table if not exists public.canonical_stops (
  id text primary key,
  city text not null,
  title text not null,
  lat double precision not null,
  lng double precision not null,
  image_url text,
  source text not null check (source in ('preset_seed', 'custom_link', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.canonical_stop_assets (
  canonical_stop_id text not null references public.canonical_stops(id) on delete cascade,
  persona text not null check (persona in ('adult', 'preteen')),
  script text,
  audio_url text,
  status text not null default 'pending' check (status in ('pending', 'generating', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (canonical_stop_id, persona),
  constraint canonical_stop_assets_script_not_blank_check
    check (script is null or btrim(script) <> ''),
  constraint canonical_stop_assets_audio_not_blank_check
    check (audio_url is null or btrim(audio_url) <> '')
);

create table if not exists public.route_stop_mappings (
  route_kind text not null check (route_kind in ('preset', 'custom')),
  route_id text not null,
  stop_id text not null,
  canonical_stop_id text not null references public.canonical_stops(id) on delete cascade,
  position int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (route_kind, route_id, stop_id)
);

create index if not exists idx_canonical_stops_city on public.canonical_stops(city);
create index if not exists idx_canonical_stop_assets_stop on public.canonical_stop_assets(canonical_stop_id);
create index if not exists idx_route_stop_mappings_route on public.route_stop_mappings(route_kind, route_id, position);
create index if not exists idx_route_stop_mappings_canonical on public.route_stop_mappings(canonical_stop_id);

drop trigger if exists trg_canonical_stops_updated_at on public.canonical_stops;
create trigger trg_canonical_stops_updated_at
before update on public.canonical_stops
for each row execute function public.set_updated_at();

drop trigger if exists trg_canonical_stop_assets_updated_at on public.canonical_stop_assets;
create trigger trg_canonical_stop_assets_updated_at
before update on public.canonical_stop_assets
for each row execute function public.set_updated_at();

drop trigger if exists trg_route_stop_mappings_updated_at on public.route_stop_mappings;
create trigger trg_route_stop_mappings_updated_at
before update on public.route_stop_mappings
for each row execute function public.set_updated_at();

-- After running in Supabase SQL editor, refresh schema cache:
-- select pg_notify('pgrst', 'reload schema');
