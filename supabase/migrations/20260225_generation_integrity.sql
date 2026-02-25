-- Generation integrity hardening:
-- 1) normalize historical blank values to NULL
-- 2) enforce non-empty script/audio fields at DB layer
-- 3) allow partial-success status: ready_with_warnings

update public.custom_route_stops
set
  script_adult = nullif(btrim(script_adult), ''),
  script_preteen = nullif(btrim(script_preteen), ''),
  audio_url_adult = nullif(btrim(audio_url_adult), ''),
  audio_url_preteen = nullif(btrim(audio_url_preteen), '')
where
  script_adult is not null
  or script_preteen is not null
  or audio_url_adult is not null
  or audio_url_preteen is not null;

alter table public.mix_generation_jobs
  drop constraint if exists mix_generation_jobs_status_check;

alter table public.mix_generation_jobs
  drop constraint if exists mix_generation_jobs_status_check_v2;

alter table public.mix_generation_jobs
  add constraint mix_generation_jobs_status_check_v2
  check (status in ('queued', 'generating_script', 'generating_audio', 'ready', 'ready_with_warnings', 'failed'));

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_script_adult_not_blank_check;
alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_script_preteen_not_blank_check;
alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_audio_url_adult_not_blank_check;
alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_audio_url_preteen_not_blank_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_script_adult_not_blank_check
  check (script_adult is null or btrim(script_adult) <> '');

alter table public.custom_route_stops
  add constraint custom_route_stops_script_preteen_not_blank_check
  check (script_preteen is null or btrim(script_preteen) <> '');

alter table public.custom_route_stops
  add constraint custom_route_stops_audio_url_adult_not_blank_check
  check (audio_url_adult is null or btrim(audio_url_adult) <> '');

alter table public.custom_route_stops
  add constraint custom_route_stops_audio_url_preteen_not_blank_check
  check (audio_url_preteen is null or btrim(audio_url_preteen) <> '');

-- After running in Supabase SQL editor, run this to refresh PostgREST schema cache:
-- select pg_notify('pgrst', 'reload schema');

-- Optional note:
-- For generated-only mode, keep missing audio as NULL and surface a UI "audio not generated yet" state.
