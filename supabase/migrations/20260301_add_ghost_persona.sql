alter table public.canonical_stop_assets
  drop constraint if exists canonical_stop_assets_persona_check;

alter table public.canonical_stop_assets
  add constraint canonical_stop_assets_persona_check
  check (persona in ('adult', 'preteen', 'ghost'));

alter table public.preset_route_stop_assets
  drop constraint if exists preset_route_stop_assets_persona_check;

alter table public.preset_route_stop_assets
  add constraint preset_route_stop_assets_persona_check
  check (persona in ('adult', 'preteen', 'ghost'));

alter table public.custom_routes
  drop constraint if exists custom_routes_narrator_default_check;

alter table public.custom_routes
  add constraint custom_routes_narrator_default_check
  check (narrator_default in ('adult', 'preteen', 'ghost'));

alter table public.custom_route_stops
  add column if not exists script_ghost text,
  add column if not exists audio_url_ghost text;

update public.custom_route_stops
set
  script_ghost = nullif(btrim(script_ghost), ''),
  audio_url_ghost = nullif(btrim(audio_url_ghost), '')
where script_ghost is not null or audio_url_ghost is not null;

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_script_ghost_not_blank_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_script_ghost_not_blank_check
  check (script_ghost is null or btrim(script_ghost) <> '');

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_audio_url_ghost_not_blank_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_audio_url_ghost_not_blank_check
  check (audio_url_ghost is null or btrim(audio_url_ghost) <> '');

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'custom_route_stops_has_generation_assets_check'
      and conrelid = 'public.custom_route_stops'::regclass
  ) then
    alter table public.custom_route_stops
      drop constraint custom_route_stops_has_generation_assets_check;

    alter table public.custom_route_stops
      add constraint custom_route_stops_has_generation_assets_check
      check (
        script_adult is not null
        or script_preteen is not null
        or script_ghost is not null
        or audio_url_adult is not null
        or audio_url_preteen is not null
        or audio_url_ghost is not null
      );
  end if;
end $$;

-- After running in Supabase SQL editor, refresh schema cache:
-- select pg_notify('pgrst', 'reload schema');
