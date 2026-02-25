create table if not exists public.preset_route_stop_assets (
  preset_route_id text not null,
  stop_id text not null,
  persona text not null check (persona in ('adult', 'preteen')),
  script text,
  audio_url text,
  status text not null default 'pending' check (status in ('pending', 'generating', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (preset_route_id, stop_id, persona),
  constraint preset_route_stop_assets_script_not_blank_check
    check (script is null or btrim(script) <> ''),
  constraint preset_route_stop_assets_audio_not_blank_check
    check (audio_url is null or btrim(audio_url) <> '')
);

create table if not exists public.preset_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  preset_route_id text not null,
  status text not null default 'queued' check (status in ('queued', 'generating_script', 'generating_audio', 'ready', 'ready_with_warnings', 'failed')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  message text not null default 'Queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_preset_route_stop_assets_route_stop
  on public.preset_route_stop_assets(preset_route_id, stop_id);

create index if not exists idx_preset_generation_jobs_jam_created
  on public.preset_generation_jobs(jam_id, created_at desc);

drop trigger if exists trg_preset_route_stop_assets_updated_at on public.preset_route_stop_assets;
create trigger trg_preset_route_stop_assets_updated_at
before update on public.preset_route_stop_assets
for each row execute function public.set_updated_at();

drop trigger if exists trg_preset_generation_jobs_updated_at on public.preset_generation_jobs;
create trigger trg_preset_generation_jobs_updated_at
before update on public.preset_generation_jobs
for each row execute function public.set_updated_at();

-- After running in Supabase SQL editor, refresh schema cache:
-- select pg_notify('pgrst', 'reload schema');
