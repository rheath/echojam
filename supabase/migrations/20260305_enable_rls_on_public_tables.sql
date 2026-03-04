-- Enable RLS on public tables flagged by Security Advisor.
-- Policies below intentionally preserve current open-access behavior for anon/authenticated users.
-- Service role remains unaffected (it bypasses RLS by design).

do $$
declare
  tbl text;
  policy_name text;
  target_tables text[] := array[
    'jams',
    'custom_routes',
    'canonical_stop_assets',
    'mix_generation_jobs',
    'custom_route_stops',
    'preset_generation_jobs',
    'preset_route_stop_assets',
    'route_stop_mappings',
    'canonical_stops'
  ];
begin
  foreach tbl in array target_tables loop
    if to_regclass(format('public.%I', tbl)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', tbl);

    policy_name := format('%s_open_access', tbl);
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = tbl
        and policyname = policy_name
    ) then
      execute format(
        'create policy %I on public.%I as permissive for all to anon, authenticated using (true) with check (true)',
        policy_name,
        tbl
      );
    end if;
  end loop;
end $$;

