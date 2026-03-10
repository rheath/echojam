alter table public.instagram_import_jobs
  add column if not exists draft_ids jsonb;

alter table public.instagram_import_jobs
  drop constraint if exists instagram_import_jobs_phase_check;

alter table public.instagram_import_jobs
  add constraint instagram_import_jobs_phase_check
  check (phase in ('import', 'publish', 'publish_collection'));

create index if not exists idx_instagram_import_jobs_phase_status_created
  on public.instagram_import_jobs(phase, status, created_at asc);
