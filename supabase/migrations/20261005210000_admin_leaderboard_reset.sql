-- Serialize imports and resets, and reject imports calculated before a reset.
create table if not exists public.leaderboard_state (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0
);
insert into public.leaderboard_state (singleton) values (true)
on conflict (singleton) do nothing;
alter table public.leaderboard_state enable row level security;
revoke all on public.leaderboard_state from public, anon, authenticated;
grant select on public.leaderboard_state to service_role;

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

  delete from public.player_matches;
  get diagnostics deleted_matches = row_count;
  delete from public.player_history;
  get diagnostics deleted_history = row_count;

  update public.players set matches = 0, score = 0, deaths = 0,
    kdr = '-', accuracy = '-', kpm = '-', crouches = 0, time_in_lobby = 0,
    elo = '-', rank = 999999, tag = '';
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

-- The Edge Function computes statistics, then persists every change atomically.
-- Only its service role may call this function, never a browser session.
create or replace function public.apply_match_import(
  p_expected_revision bigint, p_players jsonb, p_ranks jsonb,
  p_history jsonb, p_matches jsonb, p_admin_user text, p_details text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision bigint;
  imported_player public.players%rowtype;
  imported_match public.player_matches%rowtype;
  history_entry public.player_history%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select revision into current_revision from public.leaderboard_state where singleton for update;
  if current_revision is null or current_revision is distinct from p_expected_revision then
    raise exception 'Leaderboard changed during upload. Please import the files again.' using errcode = '40001';
  end if;

  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_players)
  loop
    update public.players set matches = imported_player.matches, score = imported_player.score,
      deaths = imported_player.deaths, kdr = imported_player.kdr, accuracy = imported_player.accuracy,
      kpm = imported_player.kpm, crouches = imported_player.crouches,
      time_in_lobby = imported_player.time_in_lobby, elo = imported_player.elo,
      rank = imported_player.rank, tag = imported_player.tag
    where name = imported_player.name;
    if not found then
      raise exception 'Player changed during upload. Please import the files again.' using errcode = '40001';
    end if;
  end loop;
  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_ranks)
  loop
    update public.players set rank = imported_player.rank where name = imported_player.name;
  end loop;

  for history_entry in select * from pg_catalog.jsonb_populate_recordset(null::public.player_history, p_history)
  loop
    insert into public.player_history (player_name, elo, rank)
      values (history_entry.player_name, history_entry.elo, history_entry.rank);
  end loop;
  for imported_match in select * from pg_catalog.jsonb_populate_recordset(null::public.player_matches, p_matches)
  loop
    insert into public.player_matches (player_name, score, deaths, accuracy, kpm, kdr,
      crouches, time_in_lobby, total_match_time, performance_score)
    values (imported_match.player_name, imported_match.score, imported_match.deaths,
      imported_match.accuracy, imported_match.kpm, imported_match.kdr, imported_match.crouches,
      imported_match.time_in_lobby, imported_match.total_match_time, imported_match.performance_score);
  end loop;
  insert into public.audit_logs (action, admin_user, details)
    values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, p_details);
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text)
  to service_role;
