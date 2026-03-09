alter table public.custom_routes
  add column if not exists experience_kind text not null default 'mix';

alter table public.custom_routes
  drop constraint if exists custom_routes_experience_kind_check;

alter table public.custom_routes
  add constraint custom_routes_experience_kind_check
  check (experience_kind in ('mix', 'follow_along'));

alter table public.custom_routes
  add column if not exists origin_label text,
  add column if not exists origin_lat double precision,
  add column if not exists origin_lng double precision,
  add column if not exists destination_label text,
  add column if not exists destination_lat double precision,
  add column if not exists destination_lng double precision,
  add column if not exists route_distance_meters integer,
  add column if not exists route_duration_seconds integer,
  add column if not exists route_polyline jsonb;

alter table public.custom_route_stops
  add column if not exists stop_kind text not null default 'story';

alter table public.custom_route_stops
  drop constraint if exists custom_route_stops_stop_kind_check;

alter table public.custom_route_stops
  add constraint custom_route_stops_stop_kind_check
  check (stop_kind in ('story', 'arrival'));

alter table public.custom_route_stops
  add column if not exists distance_along_route_meters integer,
  add column if not exists trigger_radius_meters integer;

create index if not exists idx_custom_route_stops_route_distance
  on public.custom_route_stops(route_id, distance_along_route_meters);
