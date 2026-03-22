create table if not exists public.mixed_composer_sessions (
  id uuid primary key default gen_random_uuid(),
  active_provider text not null default 'instagram'
    check (active_provider in ('instagram', 'tiktok', 'google_places')),
  route_title text,
  custom_narrator_guidance text,
  stops jsonb not null default '[]'::jsonb,
  instagram_draft_id uuid references public.instagram_import_drafts(id) on delete set null,
  instagram_draft_ids jsonb not null default '[]'::jsonb,
  tiktok_draft_id uuid references public.tiktok_import_drafts(id) on delete set null,
  active_import_job jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mixed_composer_sessions_stops_array_check check (jsonb_typeof(stops) = 'array'),
  constraint mixed_composer_sessions_instagram_draft_ids_array_check check (
    jsonb_typeof(instagram_draft_ids) = 'array'
  ),
  constraint mixed_composer_sessions_active_import_job_object_check check (
    active_import_job is null or jsonb_typeof(active_import_job) = 'object'
  )
);

create index if not exists idx_mixed_composer_sessions_updated
  on public.mixed_composer_sessions(updated_at desc);

drop trigger if exists trg_mixed_composer_sessions_updated_at on public.mixed_composer_sessions;
create trigger trg_mixed_composer_sessions_updated_at
before update on public.mixed_composer_sessions
for each row execute function public.set_updated_at();

alter table public.mixed_composer_sessions enable row level security;

drop policy if exists mixed_composer_sessions_open_access on public.mixed_composer_sessions;
create policy mixed_composer_sessions_open_access
on public.mixed_composer_sessions
as permissive
for all
to anon, authenticated
using (true)
with check (true);
