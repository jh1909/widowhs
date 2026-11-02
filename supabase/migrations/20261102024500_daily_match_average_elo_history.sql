-- Compute daily average ELO from the performance_score of all eligible matches
-- played on each Berlin calendar day (sum of match performance_score / match count).
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

-- Backfill existing daily rows in player_history with the exact per-day match average.
update public.player_history h
set elo = m.avg_elo,
    elo_sum = m.total_score,
    elo_samples = m.match_count
from (
  select
    player_name,
    ((coalesce(played_at, created_at) at time zone 'Europe/Berlin')::date) as match_day,
    round(avg(performance_score))::integer as avg_elo,
    sum(performance_score)::numeric as total_score,
    count(*)::bigint as match_count
  from public.player_matches
  where elo_weight > 0 and performance_score is not null
  group by player_name, ((coalesce(played_at, created_at) at time zone 'Europe/Berlin')::date)
) m
where h.player_name = m.player_name
  and h.history_day = m.match_day;

-- Record each imported eligible match's performance_score on its played_at day
-- so player_history accumulates (sum of match scores) / (match count) per day.
create or replace function public.apply_match_import(
  p_expected_revision bigint, p_players jsonb, p_ranks jsonb,
  p_history jsonb, p_matches jsonb, p_admin_user text, p_details text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  current_revision bigint;
  imported_player public.players%rowtype;
  legacy_match_id uuid := pg_catalog.gen_random_uuid();
  banned_names text[];
  skipped_banned integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select revision into current_revision from public.leaderboard_state where singleton for update;
  if current_revision is null or current_revision is distinct from p_expected_revision then
    raise exception 'Leaderboard changed during upload. Please import the files again.' using errcode = '40001';
  end if;
  select coalesce(array_agg(distinct lower(btrim(a.alias))), '{}'::text[]) into banned_names
  from public.players p cross join lateral (
    select p.name as alias
    union all select unnest(p.previous_names)
    union all select jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts),'[]'::jsonb))
  ) a where p.is_banned is true;
  select banned_names || coalesce(array_agg(distinct lower(btrim(m->>'player_name'))), '{}'::text[])
    into banned_names from jsonb_array_elements(p_matches) m
    where lower(btrim(m->>'player_name'))=any(banned_names)
      or lower(btrim(m->>'logged_player_name'))=any(banned_names);
  select count(*)::integer into skipped_banned from jsonb_array_elements(p_matches) m
    where lower(btrim(m->>'player_name'))=any(banned_names);
  select coalesce(jsonb_agg(m),'[]'::jsonb) into p_matches from jsonb_array_elements(p_matches) m
    where not (lower(btrim(m->>'player_name'))=any(banned_names));
  select coalesce(jsonb_agg(p),'[]'::jsonb) into p_players from jsonb_array_elements(p_players) p
    where not (lower(btrim(p->>'name'))=any(banned_names));
  select coalesce(jsonb_agg(p),'[]'::jsonb) into p_ranks from jsonb_array_elements(p_ranks) p
    where not (lower(btrim(p->>'name'))=any(banned_names));
  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_players) loop
    update public.players set matches = imported_player.matches, score = imported_player.score, deaths = imported_player.deaths,
      kdr = imported_player.kdr, accuracy = imported_player.accuracy, kpm = imported_player.kpm, crouches = imported_player.crouches,
      time_in_lobby = imported_player.time_in_lobby, elo = imported_player.elo, rank = imported_player.rank, tag = imported_player.tag
      where name = imported_player.name;
    if not found then
    insert into public.players (name, matches, score, deaths, kdr, accuracy, kpm, crouches, time_in_lobby, elo, rank, tag, previous_names)
    values (imported_player.name, imported_player.matches, imported_player.score, imported_player.deaths,
      imported_player.kdr, imported_player.accuracy, imported_player.kpm, imported_player.crouches,
      imported_player.time_in_lobby, imported_player.elo, imported_player.rank, imported_player.tag,
      coalesce(imported_player.previous_names, '{}'));
    end if;
  end loop;
  update public.players p set rank = r.rank
    from pg_catalog.jsonb_populate_recordset(null::public.players, p_ranks) r
    where p.name = r.name and p.rank is distinct from r.rank;
  insert into public.player_matches (player_name, logged_player_name, score, deaths, accuracy, kpm, kdr,
    crouches, time_in_lobby, total_match_time, performance_score, played_at, match_id)
  select r.player_name, coalesce(r.logged_player_name, r.player_name),
    r.score, r.deaths, r.accuracy, r.kpm, r.kdr,
    r.crouches, r.time_in_lobby, r.total_match_time, r.performance_score,
    coalesce((m.value ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now()),
    coalesce(r.match_id, legacy_match_id)
  from pg_catalog.jsonb_array_elements(p_matches) m,
    lateral pg_catalog.jsonb_populate_record(null::public.player_matches, m.value) r;
  -- Stored match rows determine PB; use the final server ranking in history.
  perform public._rerank_players_by_pb();
  -- Insert one sample per eligible match using its performance_score and played_at timestamp.
  insert into public.player_history(player_name, elo, rank, created_at)
    select r.player_name,
      r.performance_score,
      coalesce(p.rank, 999999),
      coalesce((m.value ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now())
    from pg_catalog.jsonb_array_elements(p_matches) m
    cross join lateral pg_catalog.jsonb_populate_record(null::public.player_matches, m.value) r
    join public.players p on p.name = r.player_name
    where r.performance_score is not null
      and public.match_elo_weight(r.score::numeric, r.time_in_lobby::numeric, r.total_match_time::numeric) > 0;
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, coalesce(p_details,'') || pg_catalog.format(' Database skipped %s banned participation(s).', skipped_banned));
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

-- Compute the latest 30 active days' average match ELO (sum of match performance_score / count)
-- directly from player_matches, with fallback to player_history when no match rows exist.
create or replace function public.get_player_elo_history(p_player_name text)
returns table(elo integer, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with match_days as (
    select
      round(avg(m.performance_score))::integer as elo,
      ((coalesce(m.played_at, m.created_at) at time zone 'Europe/Berlin')::date) as history_day
    from public.player_matches m
    where m.player_name = p_player_name
      and m.elo_weight > 0
      and m.performance_score is not null
      and exists (select 1 from public.players p where p.name = m.player_name)
    group by ((coalesce(m.played_at, m.created_at) at time zone 'Europe/Berlin')::date)
  ),
  fallback_days as (
    select h.elo, h.history_day
    from public.player_history h
    where not exists (select 1 from match_days)
      and h.player_name = p_player_name
      and h.elo is not null
      and h.history_day is not null
      and exists (select 1 from public.players p where p.name = h.player_name)
  ),
  recent as (
    select elo, history_day from match_days
    union all
    select elo, history_day from fallback_days
    order by history_day desc
    limit 30
  )
  select recent.elo, recent.history_day::timestamp at time zone 'Europe/Berlin' as created_at
  from recent
  order by recent.history_day asc;
$$;
revoke all on function public.get_player_elo_history(text) from public;
grant execute on function public.get_player_elo_history(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
