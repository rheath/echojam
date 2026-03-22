alter table public.mixed_composer_sessions
  add column if not exists google_place_draft jsonb;

alter table public.mixed_composer_sessions
  drop constraint if exists mixed_composer_sessions_google_place_draft_object_check;

alter table public.mixed_composer_sessions
  add constraint mixed_composer_sessions_google_place_draft_object_check check (
    google_place_draft is null or jsonb_typeof(google_place_draft) = 'object'
  );
