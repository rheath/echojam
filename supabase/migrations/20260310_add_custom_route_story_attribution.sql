alter table public.custom_routes
  add column if not exists story_by text,
  add column if not exists story_by_url text,
  add column if not exists story_by_avatar_url text,
  add column if not exists story_by_source text;

update public.custom_routes
set
  story_by = nullif(btrim(story_by), ''),
  story_by_url = nullif(btrim(story_by_url), ''),
  story_by_avatar_url = nullif(btrim(story_by_avatar_url), ''),
  story_by_source = nullif(btrim(story_by_source), '')
where
  story_by is not null
  or story_by_url is not null
  or story_by_avatar_url is not null
  or story_by_source is not null;

alter table public.custom_routes
  drop constraint if exists custom_routes_story_by_not_blank_check;

alter table public.custom_routes
  add constraint custom_routes_story_by_not_blank_check
  check (story_by is null or btrim(story_by) <> '');

alter table public.custom_routes
  drop constraint if exists custom_routes_story_by_url_not_blank_check;

alter table public.custom_routes
  add constraint custom_routes_story_by_url_not_blank_check
  check (story_by_url is null or btrim(story_by_url) <> '');

alter table public.custom_routes
  drop constraint if exists custom_routes_story_by_avatar_url_not_blank_check;

alter table public.custom_routes
  add constraint custom_routes_story_by_avatar_url_not_blank_check
  check (story_by_avatar_url is null or btrim(story_by_avatar_url) <> '');

alter table public.custom_routes
  drop constraint if exists custom_routes_story_by_source_check;

alter table public.custom_routes
  add constraint custom_routes_story_by_source_check
  check (story_by_source is null or story_by_source in ('instagram'));
