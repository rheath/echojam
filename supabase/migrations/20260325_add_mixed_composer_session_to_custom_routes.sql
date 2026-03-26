alter table public.custom_routes
  add column if not exists mixed_composer_session_id uuid references public.mixed_composer_sessions(id) on delete set null;

create index if not exists idx_custom_routes_mixed_composer_session_id
  on public.custom_routes(mixed_composer_session_id);
