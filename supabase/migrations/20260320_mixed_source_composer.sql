alter table public.custom_route_stops
  add column if not exists source_provider text,
  add column if not exists source_kind text,
  add column if not exists source_url text,
  add column if not exists source_id text,
  add column if not exists source_creator_name text,
  add column if not exists source_creator_url text,
  add column if not exists source_creator_avatar_url text;

update public.custom_route_stops
set
  source_provider = nullif(btrim(source_provider), ''),
  source_kind = nullif(btrim(source_kind), ''),
  source_url = nullif(btrim(source_url), ''),
  source_id = nullif(btrim(source_id), ''),
  source_creator_name = nullif(btrim(source_creator_name), ''),
  source_creator_url = nullif(btrim(source_creator_url), ''),
  source_creator_avatar_url = nullif(btrim(source_creator_avatar_url), '')
where
  source_provider is not null
  or source_kind is not null
  or source_url is not null
  or source_id is not null
  or source_creator_name is not null
  or source_creator_url is not null
  or source_creator_avatar_url is not null;

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_source_provider_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_source_provider_check
  check (
    source_provider is null
    or source_provider in ('instagram', 'tiktok', 'google_places')
  );

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_source_kind_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_source_kind_check
  check (
    source_kind is null
    or source_kind in ('social_import', 'place_search')
  );

alter table public.custom_routes
  drop constraint if exists custom_routes_story_by_source_check;

alter table public.custom_routes
  add constraint custom_routes_story_by_source_check
  check (
    story_by_source is null
    or story_by_source in ('instagram', 'tiktok', 'social')
  );
