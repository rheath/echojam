create table if not exists public.tiktok_import_drafts (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  source_kind text not null default 'video' check (source_kind in ('video')),
  source_video_id text,
  source_owner_title text,
  source_owner_user_id text,
  source_caption text,
  source_thumbnail_url text,
  transcript_raw text,
  transcript_cleaned text,
  generated_title text,
  generated_script text,
  edited_title text,
  edited_script text,
  place_query text,
  place_city_hint text,
  place_country_hint text,
  place_confidence numeric(4,3),
  suggested_place_label text,
  suggested_place_lat double precision,
  suggested_place_lng double precision,
  suggested_place_image_url text,
  suggested_google_place_id text,
  confirmed_place_label text,
  confirmed_place_lat double precision,
  confirmed_place_lng double precision,
  confirmed_place_image_url text,
  confirmed_google_place_id text,
  status text not null default 'pending_import'
    check (status in ('pending_import', 'importing', 'draft_ready', 'failed')),
  warning text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tiktok_import_jobs (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.tiktok_import_drafts(id) on delete cascade,
  phase text not null check (phase in ('import')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'draft_ready', 'failed')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  message text not null default 'Queued',
  error text,
  attempts int not null default 0 check (attempts >= 0),
  locked_at timestamptz,
  last_heartbeat_at timestamptz,
  lock_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tiktok_import_drafts_status_created
  on public.tiktok_import_drafts(status, created_at desc);

create index if not exists idx_tiktok_import_drafts_video
  on public.tiktok_import_drafts(source_video_id, created_at desc);

create index if not exists idx_tiktok_import_jobs_status_created
  on public.tiktok_import_jobs(status, created_at asc);

create index if not exists idx_tiktok_import_jobs_draft_created
  on public.tiktok_import_jobs(draft_id, created_at desc);

drop trigger if exists trg_tiktok_import_drafts_updated_at on public.tiktok_import_drafts;
create trigger trg_tiktok_import_drafts_updated_at
before update on public.tiktok_import_drafts
for each row execute function public.set_updated_at();

drop trigger if exists trg_tiktok_import_jobs_updated_at on public.tiktok_import_jobs;
create trigger trg_tiktok_import_jobs_updated_at
before update on public.tiktok_import_jobs
for each row execute function public.set_updated_at();

alter table public.tiktok_import_drafts enable row level security;
alter table public.tiktok_import_jobs enable row level security;

drop policy if exists tiktok_import_drafts_open_access on public.tiktok_import_drafts;
create policy tiktok_import_drafts_open_access
on public.tiktok_import_drafts
as permissive
for all
to anon, authenticated
using (true)
with check (true);

drop policy if exists tiktok_import_jobs_open_access on public.tiktok_import_jobs;
create policy tiktok_import_jobs_open_access
on public.tiktok_import_jobs
as permissive
for all
to anon, authenticated
using (true)
with check (true);
