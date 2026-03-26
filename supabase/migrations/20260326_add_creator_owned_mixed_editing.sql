alter table public.jams
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_jams_owner_user_id
  on public.jams(owner_user_id, created_at desc);

alter table public.custom_routes
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists is_live boolean not null default true,
  add column if not exists base_route_id uuid references public.custom_routes(id) on delete set null,
  add column if not exists superseded_at timestamptz,
  add column if not exists published_at timestamptz;

create index if not exists idx_custom_routes_owner_user_id
  on public.custom_routes(owner_user_id, updated_at desc);

create index if not exists idx_custom_routes_jam_live
  on public.custom_routes(jam_id, is_live, updated_at desc);

create index if not exists idx_custom_routes_base_route_id
  on public.custom_routes(base_route_id);

alter table public.custom_routes
  drop constraint if exists custom_routes_jam_id_key;

update public.custom_routes
set published_at = coalesce(published_at, created_at)
where is_live = true and published_at is null;

alter table public.mixed_composer_sessions
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists jam_id uuid references public.jams(id) on delete set null,
  add column if not exists base_route_id uuid references public.custom_routes(id) on delete set null,
  add column if not exists draft_status text not null default 'draft'
    check (draft_status in ('draft', 'publishing'));

create index if not exists idx_mixed_composer_sessions_owner_updated
  on public.mixed_composer_sessions(owner_user_id, updated_at desc);

create index if not exists idx_mixed_composer_sessions_owner_jam
  on public.mixed_composer_sessions(owner_user_id, jam_id, updated_at desc);

drop policy if exists mixed_composer_sessions_open_access on public.mixed_composer_sessions;

create policy mixed_composer_sessions_owner_access
on public.mixed_composer_sessions
as permissive
for all
to authenticated
using (auth.uid() = owner_user_id)
with check (auth.uid() = owner_user_id);
