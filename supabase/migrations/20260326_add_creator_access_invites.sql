create table if not exists public.creator_access_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  scope text not null check (scope in ('mixed', 'instagram', 'tiktok', 'all')),
  claimed_user_id uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_creator_access_invites_code_hash_email_scope
  on public.creator_access_invites(code_hash, lower(email), scope);

create index if not exists idx_creator_access_invites_claimed_user_id
  on public.creator_access_invites(claimed_user_id, created_at desc);

create index if not exists idx_creator_access_invites_email
  on public.creator_access_invites(lower(email), created_at desc);

drop trigger if exists set_creator_access_invites_updated_at on public.creator_access_invites;
create trigger set_creator_access_invites_updated_at
before update on public.creator_access_invites
for each row execute function public.set_updated_at();
