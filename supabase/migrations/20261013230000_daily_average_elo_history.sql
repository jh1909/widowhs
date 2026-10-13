begin;

select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_history, public.player_matches in share row exclusive mode;

-- Keep the sum and sample count so another update, or an account merge,
-- computes the true average instead of averaging already-rounded averages.
alter table public.player_history add column if not exists elo_sum numeric;
alter table public.player_history add column if not exists elo_samples bigint;
alter table public.player_history add column if not exists history_day date
  generated always as ((created_at at time zone 'Europe/Berlin')::date) stored;

update public.player_history set elo_sum = elo, elo_samples = 1
  where elo is not null and created_at is not null and (elo_sum is null or elo_samples is null);
create index if not exists player_history_daily_profile_idx
  on public.player_history(player_name, history_day desc);

create or replace function public._compact_daily_elo_history(p_names text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare day_stats record; keeper public.player_history.id%type;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  for day_stats in
    select player_name, history_day, sum(elo_sum) as total, sum(elo_samples)::bigint as samples,
      max(created_at) as latest_at, (array_agg(rank order by created_at desc, id desc))[1] as latest_rank
    from public.player_history
    where elo is not null and history_day is not null and elo_samples > 0
      and (p_names is null or player_name = any(p_names))
    group by player_name, history_day having count(*) > 1
    order by player_name, history_day
  loop
    select id into keeper from public.player_history
      where player_name = day_stats.player_name and history_day = day_stats.history_day
        and elo is not null and elo_samples > 0
      order by created_at, id limit 1;
    update public.player_history set elo = round(day_stats.total / day_stats.samples)::integer,
      elo_sum = day_stats.total, elo_samples = day_stats.samples,
      created_at = day_stats.latest_at, rank = day_stats.latest_rank where id = keeper;
    delete from public.player_history where player_name = day_stats.player_name
      and history_day = day_stats.history_day and elo is not null and elo_samples > 0 and id <> keeper;
  end loop;
end $$;
revoke all on function public._compact_daily_elo_history(text[]) from public, anon, authenticated, service_role;

create or replace function public.prepare_daily_elo_sample()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  if tg_op = 'INSERT' then
    if new.elo is null or new.created_at is null then
      raise exception 'An ELO update needs a rating and timestamp.' using errcode = '22023';
    end if;
    new.elo_sum := new.elo;
    new.elo_samples := 1;
  elsif new.elo is distinct from old.elo and new.elo_sum is not distinct from old.elo_sum
    and new.elo_samples is not distinct from old.elo_samples then
    -- A privileged correction of a daily rating updates its aggregate too.
    new.elo_sum := new.elo * coalesce(old.elo_samples, 1);
  end if;
  return new;
end $$;
revoke all on function public.prepare_daily_elo_sample() from public, anon, authenticated, service_role;
drop trigger if exists prepare_daily_elo_sample on public.player_history;
create trigger prepare_daily_elo_sample before insert or update on public.player_history
  for each row execute function public.prepare_daily_elo_sample();

create or replace function public.compact_changed_elo_days()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected_names text[];
begin
  select array_agg(distinct player_name) into affected_names from changed_elo_rows;
  if affected_names is not null then perform public._compact_daily_elo_history(affected_names); end if;
  return null;
end $$;
revoke all on function public.compact_changed_elo_days() from public, anon, authenticated, service_role;
drop trigger if exists compact_inserted_elo_days on public.player_history;
create trigger compact_inserted_elo_days after insert on public.player_history
  referencing new table as changed_elo_rows for each statement execute function public.compact_changed_elo_days();
drop trigger if exists compact_updated_elo_days on public.player_history;

create or replace function public.compact_moved_elo_day()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._compact_daily_elo_history(array[new.player_name]);
  return new;
end $$;
revoke all on function public.compact_moved_elo_day() from public, anon, authenticated, service_role;
drop trigger if exists compact_moved_elo_day on public.player_history;
create trigger compact_moved_elo_day after update of player_name, created_at on public.player_history
  for each row when (old.player_name is distinct from new.player_name or old.history_day is distinct from new.history_day)
  execute function public.compact_moved_elo_day();

-- Existing imports still INSERT their snapshots; the triggers fold those into
-- one physical row per player/day. Existing rename, merge and reset RPCs work
-- with the same table, and no Edge Function redeployment is needed.
select public._compact_daily_elo_history();
drop index if exists public.player_history_recent_profile_idx;
revoke insert, update, delete on public.player_history from anon, authenticated;

create or replace function public.get_player_elo_history(p_player_name text)
returns table(elo integer, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select recent.elo, recent.history_day::timestamp at time zone 'Europe/Berlin'
  from (
    select h.elo, h.history_day from public.player_history h
    where h.player_name = p_player_name and h.elo is not null and h.history_day is not null
      and exists (select 1 from public.players p where p.name = h.player_name)
    order by h.history_day desc limit 30
  ) recent order by recent.history_day asc;
$$;
revoke all on function public.get_player_elo_history(text) from public;
grant execute on function public.get_player_elo_history(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
