update public.creator_access_invites
set scope = 'mixed'
where scope in ('instagram', 'tiktok', 'all');

alter table public.creator_access_invites
  drop constraint if exists creator_access_invites_scope_check;

alter table public.creator_access_invites
  add constraint creator_access_invites_scope_check
  check (scope = 'mixed');
