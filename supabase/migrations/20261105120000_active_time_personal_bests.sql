-- Requires log_ingest (and timed_score_events when using v3 logs).
-- Apply on staging, then production, before deploying the profile change.
-- PBs use the actual winning session's duration minus AFK time. Legacy logs
-- without sessions retain their recorded playing time; do not invent AFK time.
-- Public match results identify the logged winning session, not summed kills.
-- No Workshop log-format or SR change is needed. Refresh existing PBs in place.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_history, public.player_matches,
  public.player_sessions, public.raw_logs in share row exclusive mode;

create function public._round_winning_session(p_match uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then min(s.session_no)::integer end
  from public.player_sessions s join public.raw_logs l on l.match_id = s.match_id
  where s.match_id = p_match and l.format_version in (2, 3)
    and s.status = 'present' and s.kills >= 50
    and lower(s.logged_name) = lower(btrim(l.winner_name))
    and s.start_s >= 0 and s.end_s = l.round_length;
$$;
revoke all on function public._round_winning_session(uuid) from public, anon, authenticated, service_role;

create function public._player_personal_best(p_name text)
returns numeric language sql stable security definer set search_path = '' as $$
  with session_wins as (
    select s.end_s - s.start_s - s.afk_seconds as seconds
    from public.player_sessions s
    join public.player_matches m on m.id = s.participation_id and m.match_id = s.match_id
    where m.player_name = p_name and s.afk_seconds >= 0
      and s.session_no = public._round_winning_session(s.match_id)
  ), times as (
    -- A summed rejoin score cannot establish a win or a time to 50.
    select seconds from session_wins
    union all
    select m.time_in_lobby from public.player_matches m
    where m.player_name = p_name and m.status is null and m.score >= 50
      and not exists (select 1 from public.raw_logs l where l.match_id = m.match_id and l.format_version in (2, 3))
  )
  select min(seconds) from times
  where seconds > 0 and seconds::text not in ('NaN', 'Infinity', '-Infinity');
$$;
revoke all on function public._player_personal_best(text) from public, anon, authenticated, service_role;

create or replace function public.derive_player_personal_best()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.personal_best_time := public._player_personal_best(case when tg_op = 'UPDATE' then old.name else new.name end);
  return new;
end;
$$;

create or replace function public._refresh_player_personal_bests(p_names text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  with bests as (
    select name, public._player_personal_best(name) as best from public.players
    where p_names is null or name = any(p_names)
  )
  update public.players p set personal_best_time = b.best from bests b
    where p.name = b.name and p.personal_best_time is distinct from b.best;
  get diagnostics changed = row_count;
  if changed > 0 then
    perform public._rerank_players_by_pb();
    update public.leaderboard_state set revision = revision + 1 where singleton;
  end if;
end;
$$;

-- Imports insert participations before their sessions. Refresh again after
-- session writes, and after corrections to the logged winner/round boundary.
-- Both source tables expose match_id through these statement transition tables.
create function public.refresh_logged_personal_bests()
returns trigger language plpgsql security definer set search_path = '' as $$
declare matches uuid[]; names text[];
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  if tg_op = 'INSERT' then
    select array_agg(distinct match_id) into matches from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct match_id) into matches from old_rows;
  else
    select array_agg(distinct match_id) into matches from
      (select match_id from old_rows union select match_id from new_rows) affected;
  end if;
  select array_agg(distinct player_name) into names from public.player_matches where match_id = any(matches);
  if names is not null then perform public._refresh_player_personal_bests(names); end if;
  return null;
end;
$$;
revoke all on function public.refresh_logged_personal_bests() from public, anon, authenticated, service_role;

create trigger session_personal_bests_insert after insert on public.player_sessions
  referencing new table as new_rows for each statement execute function public.refresh_logged_personal_bests();
create trigger session_personal_bests_update after update on public.player_sessions
  referencing old table as old_rows new table as new_rows for each statement execute function public.refresh_logged_personal_bests();
create trigger session_personal_bests_delete after delete on public.player_sessions
  referencing old table as old_rows for each statement execute function public.refresh_logged_personal_bests();
create trigger log_personal_bests_insert after insert on public.raw_logs
  referencing new table as new_rows for each statement execute function public.refresh_logged_personal_bests();
create trigger log_personal_bests_update after update on public.raw_logs
  referencing old table as old_rows new table as new_rows for each statement execute function public.refresh_logged_personal_bests();
create trigger log_personal_bests_delete after delete on public.raw_logs
  referencing old table as old_rows for each statement execute function public.refresh_logged_personal_bests();

create or replace function public.get_global_matches(p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  with rounds as (
    select match_id, min(played_at) as played_at, count(*) as player_count,
      max(total_match_time) as total_match_time, sum(score) as total_kills,
      bool_or(status is not null) as has_sessions,
      (array_agg(coalesce(logged_player_name, player_name) order by score desc,
        coalesce(logged_player_name, player_name) collate "C") filter (where score >= 50))[1] as legacy_winner
    from public.player_matches group by match_id
  ), page as (
    select * from rounds order by played_at desc, match_id desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  ), results as (
    select r.match_id, r.played_at, r.player_count, r.total_match_time, r.total_kills,
      case when r.has_sessions or l.format_version in (2, 3)
        then coalesce(m.logged_player_name, m.player_name) else r.legacy_winner end as winner
    from page r left join public.raw_logs l on l.match_id = r.match_id
    left join public.player_sessions s on s.match_id = r.match_id
      and s.session_no = public._round_winning_session(r.match_id)
    left join public.player_matches m on m.id = s.participation_id and m.match_id = r.match_id
  )
  select jsonb_build_object('total', (select count(*) from rounds),
    'matches', coalesce((select jsonb_agg(to_jsonb(results) order by played_at desc, match_id desc) from results), '[]'::jsonb));
$$;

create or replace function public.get_match_details(p_match_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with participants as (
    select m.*, p.avatar_url, coalesce(p.is_verified, false) as is_verified,
      case when m.status is not null or l.format_version in (2, 3)
        then coalesce(s.participation_id = m.id, false) else coalesce(m.score >= 50, false) end as is_winner
    from public.player_matches m left join public.players p on p.name = m.player_name
    left join public.raw_logs l on l.match_id = m.match_id
    left join public.player_sessions s on s.match_id = m.match_id
      and s.session_no = public._round_winning_session(p_match_id)
    where m.match_id = p_match_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_name', player_name, 'logged_player_name', coalesce(logged_player_name, player_name),
    'avatar_url', avatar_url, 'is_verified', is_verified, 'is_winner', is_winner,
    'score', score, 'deaths', deaths, 'accuracy', accuracy, 'kpm', kpm, 'kdr', kdr,
    'crouches', crouches, 'time_in_lobby', time_in_lobby, 'total_match_time', total_match_time,
    'performance_score', performance_score, 'played_at', played_at, 'status', status, 'afk_seconds', afk_seconds
  ) order by is_winner desc, score desc, time_in_lobby asc, coalesce(logged_player_name, player_name) collate "C"), '[]'::jsonb)
  from participants;
$$;

select public._refresh_player_personal_bests();
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
