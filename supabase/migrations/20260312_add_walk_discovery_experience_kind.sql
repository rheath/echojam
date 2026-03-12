alter table public.custom_routes
  drop constraint if exists custom_routes_experience_kind_check;

alter table public.custom_routes
  add constraint custom_routes_experience_kind_check
  check (experience_kind in ('mix', 'follow_along', 'walk_discovery'));
