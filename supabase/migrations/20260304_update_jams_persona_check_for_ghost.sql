alter table public.jams
  drop constraint if exists jams_persona_check;

alter table public.jams
  add constraint jams_persona_check
  check (persona in ('adult', 'preteen', 'ghost'));

