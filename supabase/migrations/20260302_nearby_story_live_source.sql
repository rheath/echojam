alter table public.canonical_stops
  drop constraint if exists canonical_stops_source_check;

alter table public.canonical_stops
  add constraint canonical_stops_source_check
  check (source in ('preset_seed', 'custom_link', 'manual', 'live_nearby'));

create index if not exists idx_canonical_stops_city_place_id
  on public.canonical_stops(city, google_place_id)
  where google_place_id is not null;

-- After running in Supabase SQL editor, refresh schema cache:
-- select pg_notify('pgrst', 'reload schema');
