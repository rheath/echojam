-- 1) Remove polluted Pexels IDs from google_place_id
update public.canonical_stops
set google_place_id = null
where google_place_id ilike 'pexels:%';

-- 2) Deduplicate true Google place IDs by (city, google_place_id)
with ranked as (
  select
    id,
    city,
    google_place_id,
    first_value(id) over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as keep_id,
    row_number() over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as rn
  from public.canonical_stops
  where google_place_id is not null
),
dupes as (
  select id as drop_id, keep_id
  from ranked
  where rn > 1
)
insert into public.canonical_stop_assets (
  canonical_stop_id,
  persona,
  script,
  audio_url,
  status,
  error,
  created_at,
  updated_at
)
select
  d.keep_id,
  a.persona,
  a.script,
  a.audio_url,
  a.status,
  a.error,
  a.created_at,
  a.updated_at
from public.canonical_stop_assets a
join dupes d on d.drop_id = a.canonical_stop_id
on conflict (canonical_stop_id, persona)
do update set
  script = coalesce(public.canonical_stop_assets.script, excluded.script),
  audio_url = coalesce(public.canonical_stop_assets.audio_url, excluded.audio_url),
  status = case
    when public.canonical_stop_assets.status = 'ready' then public.canonical_stop_assets.status
    when excluded.status = 'ready' then excluded.status
    else public.canonical_stop_assets.status
  end,
  error = coalesce(public.canonical_stop_assets.error, excluded.error),
  updated_at = greatest(public.canonical_stop_assets.updated_at, excluded.updated_at);

with ranked as (
  select
    id,
    city,
    google_place_id,
    first_value(id) over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as keep_id,
    row_number() over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as rn
  from public.canonical_stops
  where google_place_id is not null
),
dupes as (
  select id as drop_id, keep_id
  from ranked
  where rn > 1
)
update public.route_stop_mappings r
set canonical_stop_id = d.keep_id
from dupes d
where r.canonical_stop_id = d.drop_id;

with ranked as (
  select
    id,
    city,
    google_place_id,
    first_value(id) over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as keep_id,
    row_number() over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as rn
  from public.canonical_stops
  where google_place_id is not null
),
dupes as (
  select id as drop_id, keep_id
  from ranked
  where rn > 1
)
delete from public.canonical_stop_assets a
using dupes d
where a.canonical_stop_id = d.drop_id;

with ranked as (
  select
    id,
    city,
    google_place_id,
    first_value(id) over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as keep_id,
    row_number() over (
      partition by city, google_place_id
      order by
        case when image_source = 'curated' then 0 else 1 end,
        created_at asc,
        id asc
    ) as rn
  from public.canonical_stops
  where google_place_id is not null
),
dupes as (
  select id as drop_id, keep_id
  from ranked
  where rn > 1
)
delete from public.canonical_stops c
using dupes d
where c.id = d.drop_id;

-- 3) Integrity guardrails
drop index if exists idx_canonical_stops_city_place_id;

create unique index if not exists uq_canonical_stops_city_google_place_id
  on public.canonical_stops(city, google_place_id)
  where google_place_id is not null;

alter table public.canonical_stops
  drop constraint if exists canonical_stops_google_place_id_format_check;

alter table public.canonical_stops
  add constraint canonical_stops_google_place_id_format_check
  check (
    google_place_id is null
    or google_place_id !~* '^pexels:'
  );

-- After running in Supabase SQL editor, refresh schema cache:
-- select pg_notify('pgrst', 'reload schema');
