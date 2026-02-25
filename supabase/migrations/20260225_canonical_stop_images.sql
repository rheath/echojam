alter table public.canonical_stops
  add column if not exists google_place_id text;

alter table public.canonical_stops
  add column if not exists image_source text not null default 'placeholder'
  check (image_source in ('places', 'curated', 'placeholder', 'link_seed'));

alter table public.canonical_stops
  add column if not exists image_last_checked_at timestamptz;

alter table public.canonical_stops
  add column if not exists fallback_image_url text;

create index if not exists idx_canonical_stops_image_source_checked
  on public.canonical_stops(image_source, image_last_checked_at);
