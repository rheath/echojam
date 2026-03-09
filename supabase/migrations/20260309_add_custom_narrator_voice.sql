alter table public.custom_routes
  add column if not exists narrator_voice text;

update public.custom_routes
set narrator_voice = nullif(btrim(narrator_voice), '')
where narrator_voice is not null;

alter table public.custom_routes
  drop constraint if exists custom_routes_narrator_voice_check;

alter table public.custom_routes
  add constraint custom_routes_narrator_voice_check
  check (
    narrator_voice is null
    or narrator_voice in ('alloy', 'nova', 'shimmer', 'onyx')
  );
