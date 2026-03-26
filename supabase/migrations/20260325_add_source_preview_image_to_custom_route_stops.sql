alter table public.custom_route_stops
  add column if not exists source_preview_image_url text;
