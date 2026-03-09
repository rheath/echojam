alter table public.jams
add column if not exists listen_count bigint not null default 0;

create or replace function public.increment_jam_listen_count(p_jam_id uuid)
returns bigint
language plpgsql
as $$
declare
  next_count bigint;
begin
  update public.jams
  set listen_count = coalesce(listen_count, 0) + 1
  where id = p_jam_id
  returning listen_count into next_count;

  return next_count;
end;
$$;
