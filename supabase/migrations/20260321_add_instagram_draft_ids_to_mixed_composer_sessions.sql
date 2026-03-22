alter table public.mixed_composer_sessions
  add column if not exists instagram_draft_ids jsonb not null default '[]'::jsonb;

alter table public.mixed_composer_sessions
  drop constraint if exists mixed_composer_sessions_instagram_draft_ids_array_check;

alter table public.mixed_composer_sessions
  add constraint mixed_composer_sessions_instagram_draft_ids_array_check
  check (jsonb_typeof(instagram_draft_ids) = 'array');
