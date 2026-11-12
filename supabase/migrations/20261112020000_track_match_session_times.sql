-- Track session times (join_time, end_time, active_time) and round winner without changing Elo calculations.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

alter table public.player_matches
  add column if not exists join_time numeric,
  add column if not exists end_time numeric,
  add column if not exists active_time numeric,
  add column if not exists round_winner text;

comment on column public.player_matches.join_time is 'Session join time in seconds from round start; NULL for legacy imports.';
comment on column public.player_matches.end_time is 'Session end time in seconds from round start; NULL for legacy imports.';
comment on column public.player_matches.active_time is 'Active playing time in seconds; NULL for legacy imports.';
comment on column public.player_matches.round_winner is 'Winner name from #R summary or match completion; NULL for legacy imports.';

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
    crouches, time_in_lobby, total_match_time, performance_score, played_at, match_id,
    join_time, end_time, active_time, round_winner)
  select r.player_name, coalesce(r.logged_player_name, r.player_name),
    r.score, r.deaths, r.accuracy, r.kpm, r.kdr,
    r.crouches, r.time_in_lobby, r.total_match_time, r.performance_score,
    coalesce((m.value ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now()),
    coalesce(r.match_id, legacy_match_id),
    r.join_time, r.end_time, r.active_time, r.round_winner
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

create or replace function public.get_match_details(p_match_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_name', m.player_name, 'logged_player_name', coalesce(m.logged_player_name, m.player_name),
    'avatar_url', p.avatar_url, 'is_verified', coalesce(p.is_verified, false),
    'score', m.score, 'deaths', m.deaths, 'accuracy', m.accuracy, 'kpm', m.kpm, 'kdr', m.kdr,
    'crouches', m.crouches, 'time_in_lobby', m.time_in_lobby, 'total_match_time', m.total_match_time,
    'performance_score', m.performance_score, 'played_at', m.played_at,
    'join_time', m.join_time, 'end_time', m.end_time, 'active_time', m.active_time,
    'round_winner', m.round_winner
  ) order by m.score desc, m.time_in_lobby asc, coalesce(m.logged_player_name, m.player_name) collate "C"), '[]'::jsonb)
  from public.player_matches m
  left join public.players p on p.name = m.player_name
  where m.match_id = p_match_id;
$$;
revoke all on function public.get_match_details(uuid) from public;
grant execute on function public.get_match_details(uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
