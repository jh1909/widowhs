-- Compatibility with pg-safeupdate: explicit all-row conditions for admin reset.
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

  delete from public.player_matches where true;
  get diagnostics deleted_matches = row_count;
  delete from public.player_history where true;
  get diagnostics deleted_history = row_count;

  update public.players set matches = 0, score = 0, deaths = 0,
    kdr = '-', accuracy = '-', kpm = '-', crouches = 0, time_in_lobby = 0,
    elo = '-', rank = 999999, tag = '' where true;
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

