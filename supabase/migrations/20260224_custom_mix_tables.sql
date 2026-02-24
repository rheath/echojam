create extension if not exists "pgcrypto";

create table if not exists public.custom_routes (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null unique references public.jams(id) on delete cascade,
  city text not null,
  transport_mode text not null check (transport_mode in ('walk', 'drive')),
  length_minutes int not null,
  title text not null,
  narrator_default text not null check (narrator_default in ('adult', 'preteen')),
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.custom_route_stops (
  id bigint generated always as identity primary key,
  route_id uuid not null references public.custom_routes(id) on delete cascade,
  stop_id text not null,
  position int not null,
  title text not null,
  lat double precision not null,
  lng double precision not null,
  image_url text not null,
  script_adult text,
  script_preteen text,
  audio_url_adult text,
  audio_url_preteen text,
  created_at timestamptz not null default now(),
  unique(route_id, position)
);

create table if not exists public.mix_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  route_id uuid references public.custom_routes(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'generating_script', 'generating_audio', 'ready', 'failed')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  message text not null default 'Queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_custom_route_stops_route_position on public.custom_route_stops(route_id, position);
create index if not exists idx_mix_generation_jobs_jam on public.mix_generation_jobs(jam_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_custom_routes_updated_at on public.custom_routes;
create trigger trg_custom_routes_updated_at
before update on public.custom_routes
for each row execute function public.set_updated_at();

drop trigger if exists trg_mix_generation_jobs_updated_at on public.mix_generation_jobs;
create trigger trg_mix_generation_jobs_updated_at
before update on public.mix_generation_jobs
for each row execute function public.set_updated_at();
