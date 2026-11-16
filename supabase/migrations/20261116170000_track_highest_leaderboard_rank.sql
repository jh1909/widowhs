-- Track each player's highest qualified leaderboard rank on public.players.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

alter table public.players add column if not exists highest_rank integer;

create or replace function public.guard_player_highest_rank()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if (tg_op = 'INSERT' and new.highest_rank is not null) or
      (tg_op = 'UPDATE' and new.highest_rank is distinct from old.highest_rank) then
      raise exception 'Highest rank is managed by the server.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_player_highest_rank() from public, anon, authenticated, service_role;
drop trigger if exists guard_player_highest_rank on public.players;
create trigger guard_player_highest_rank before insert or update of highest_rank on public.players
  for each row execute function public.guard_player_highest_rank();

create or replace function public._rerank_players_by_pb()
returns void language plpgsql security definer set search_path = '' as $$
begin
  with ranked as (select name, row_number() over (order by
    replace(elo::text, ',', '')::numeric desc, personal_best_time asc nulls last,
    lower(name) collate "C", name collate "C")::integer as position
    from public.players where is_banned is not true and elo_weight_sum > 0
      and replace(elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'),
  positions as (select p.name, coalesce(r.position, 999999) as position from public.players p left join ranked r on r.name = p.name)
  update public.players p set rank = r.position from positions r
    where p.name = r.name and p.rank::text is distinct from r.position::text;

  with qualified as (
    select
      name,
      pg_catalog.row_number() over (
        order by
          pg_catalog.replace(elo::text, ',', '')::numeric desc,
          case when personal_best_time > 0 and personal_best_time::text not in ('NaN', 'Infinity', '-Infinity') then personal_best_time else null end asc nulls last,
          pg_catalog.lower(name) collate "C",
          name collate "C"
      )::integer as position
    from public.players
    where is_banned is not true
      and coalesce(placement_matches, matches, 0) >= 10
      and elo is not null
      and pg_catalog.replace(elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
  )
  update public.players p
  set highest_rank = least(coalesce(p.highest_rank, q.position), q.position)
  from qualified q
  where p.name = q.name
    and (p.highest_rank is null or q.position < p.highest_rank);
end;
$$;
revoke all on function public._rerank_players_by_pb() from public, anon, authenticated, service_role;

create or replace function public.reset_leaderboard(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  reset_players bigint;
  deleted_matches bigint;
  deleted_history bigint;
begin
  if actor is null or not exists (
    select 1 from public.players where user_id = actor and is_admin is true
  ) then
    raise exception 'Only administrators can reset the leaderboard.' using errcode = '42501';
  end if;
  if p_confirmation is distinct from 'RESET' then
    raise exception 'Type RESET to confirm.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select name into actor_name from public.players
    where user_id = actor and is_admin is true limit 1;
  if actor_name is null then
    raise exception 'Administrator permission has been revoked.' using errcode = '42501';
  end if;

  delete from public.player_elo_legacy where true;
  delete from public.player_matches where true;
  get diagnostics deleted_matches = row_count;
  delete from public.player_history where true;
  get diagnostics deleted_history = row_count;

  update public.players set matches = 0, score = 0, deaths = 0,
    kdr = '-', accuracy = '-', kpm = '-', crouches = 0, time_in_lobby = 0,
    elo = '-', rank = 999999, highest_rank = null, tag = '' where true;
  get diagnostics reset_players = row_count;
  update public.leaderboard_state set revision = revision + 1 where singleton;

  insert into public.audit_logs (action, admin_user, details) values (
    'RESET_LEADERBOARD', actor_name,
    pg_catalog.format('Reset %s profiles; removed %s matches and %s ELO history entries. Actor: %s.',
      reset_players, deleted_matches, deleted_history, actor)
  );

  return pg_catalog.jsonb_build_object('players', reset_players,
    'matches', deleted_matches, 'history', deleted_history);
end;
$$;
revoke all on function public.reset_leaderboard(text) from public, anon;
grant execute on function public.reset_leaderboard(text) to authenticated;

select public._rerank_players_by_pb();
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
