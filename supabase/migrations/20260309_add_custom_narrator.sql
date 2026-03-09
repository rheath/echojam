alter table public.jams
  drop constraint if exists jams_persona_check;

alter table public.jams
  add constraint jams_persona_check
  check (persona in ('adult', 'preteen', 'ghost', 'custom'));

alter table public.custom_routes
  add column if not exists narrator_guidance text;

update public.custom_routes
set narrator_guidance = nullif(btrim(narrator_guidance), '')
where narrator_guidance is not null;

alter table public.custom_routes
  drop constraint if exists custom_routes_narrator_default_check;

alter table public.custom_routes
  add constraint custom_routes_narrator_default_check
  check (narrator_default in ('adult', 'preteen', 'ghost', 'custom'));

alter table public.custom_routes
  drop constraint if exists custom_routes_narrator_guidance_not_blank_check;

alter table public.custom_routes
  add constraint custom_routes_narrator_guidance_not_blank_check
  check (narrator_guidance is null or btrim(narrator_guidance) <> '');

alter table public.custom_route_stops
  add column if not exists script_custom text,
  add column if not exists audio_url_custom text;

update public.custom_route_stops
set
  script_custom = nullif(btrim(script_custom), ''),
  audio_url_custom = nullif(btrim(audio_url_custom), '')
where script_custom is not null or audio_url_custom is not null;

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_script_custom_not_blank_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_script_custom_not_blank_check
  check (script_custom is null or btrim(script_custom) <> '');

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_audio_url_custom_not_blank_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_audio_url_custom_not_blank_check
  check (audio_url_custom is null or btrim(audio_url_custom) <> '');

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
        or script_custom is not null
        or audio_url_adult is not null
        or audio_url_preteen is not null
        or audio_url_ghost is not null
        or audio_url_custom is not null
      );
  end if;
end $$;
