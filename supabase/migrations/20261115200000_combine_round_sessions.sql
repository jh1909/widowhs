-- Provisional ELO combines a player's sessions in one round into a single participation.
-- Sessions stay stored separately in player_matches; ELO, placements and daily history read player_rounds.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

create or replace function public.match_rating(p_kpm numeric, p_accuracy numeric, p_kdr numeric)
returns integer language sql immutable parallel safe set search_path = '' as $$
  select round((least(p_kpm / 16.67, 1.67) * .65 + least(p_accuracy / 60, 1.15) * .25
    + least(p_kdr, 4) / 3 * .10) * 1000)::integer;
$$;
revoke all on function public.match_rating(numeric, numeric, numeric) from public;

-- Same combination as combineSessions() in supabase/functions/_shared/sessions.ts.
-- Single-session rounds keep their stored values unchanged.
create or replace view public.player_rounds with (security_invoker = true) as
select player_name, match_id, sessions, played_at, created_at, score, deaths, crouches, time_in_lobby,
  active_time, total_match_time, kdr, kpm, accuracy,
  case when sessions = 1 then single_weight
    else public.match_elo_weight(score::numeric, active_time::numeric, total_match_time::numeric) end as elo_weight,
  case when sessions = 1 then single_rating
    else public.match_rating(kpm::numeric, accuracy::numeric, kdr::numeric) end as performance_score
from (
  select player_name, match_id, count(*)::integer as sessions,
    min(played_at) as played_at, min(created_at) as created_at,
    sum(score) as score, sum(deaths) as deaths, sum(crouches) as crouches, sum(time_in_lobby) as time_in_lobby,
    sum(coalesce(active_time, time_in_lobby)) as active_time, max(total_match_time) as total_match_time,
    case when count(*) = 1 then max(kdr)
      when sum(deaths) > 0 then sum(score)::numeric / sum(deaths) else sum(score) end as kdr,
    case when count(*) = 1 then max(kpm)
      when sum(coalesce(active_time, time_in_lobby)) > 0 then sum(score) * 60.0 / sum(coalesce(active_time, time_in_lobby))
      else avg(kpm) end as kpm,
    case when count(*) = 1 then max(accuracy)
      else sum(coalesce(accuracy, 0) * coalesce(nullif(coalesce(active_time, time_in_lobby), 0), 1))
        / sum(coalesce(nullif(coalesce(active_time, time_in_lobby), 0), 1)) end as accuracy,
    max(elo_weight) as single_weight, max(performance_score) as single_rating
  from public.player_matches
  group by player_name, match_id
) rounds;
revoke all on public.player_rounds from public, anon, authenticated;

create or replace function public.derive_player_weighted_elo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_name text; rating integer;
begin
  source_name := case when tg_op='UPDATE' then old.name else new.name end;
  select count(*)::integer,coalesce(sum(elo_weight),0),
    coalesce(sum(kpm*elo_weight),0),coalesce(sum(accuracy*elo_weight),0),coalesce(sum(kdr*elo_weight),0),
    coalesce(sum(crouches),0),coalesce(sum(time_in_lobby),0)
    into new.recent_matches,new.elo_weight_sum,new.elo_kpm_sum,new.elo_accuracy_sum,new.elo_kdr_sum,
      new.recent_crouches,new.recent_time_in_lobby
  from (select * from public.player_rounds where player_name=source_name and elo_weight>0
    order by played_at desc,created_at desc,match_id desc limit 100) recent;

  select count(*)::integer into new.speedrunner_count from public.player_matches
    where player_name=source_name and score>=50 and total_match_time>0 and total_match_time<180;

  if new.elo_weight_sum>0 then
    new.recent_kdr := round(new.elo_kdr_sum/new.elo_weight_sum,2);
    new.recent_accuracy := round(new.elo_accuracy_sum/new.elo_weight_sum,2);
    new.recent_kpm := round(new.elo_kpm_sum/new.elo_weight_sum,2);
    rating := round((least(new.elo_kpm_sum/new.elo_weight_sum/16.67,1.67)*.65 +
      least(new.elo_accuracy_sum/new.elo_weight_sum/60,1.15)*.25 +
      least(new.elo_kdr_sum/new.elo_weight_sum,4)/3*.10)*1000);
    new.elo := pg_catalog.to_char(rating,'FM9,999,999,990');
    new.tag := case when rating>=1200 then 'PRO' else '' end;
  else
    new.recent_kdr := null; new.recent_accuracy := null; new.recent_kpm := null;
    new.elo := '-'; new.tag := ''; new.rank := 999999;
  end if;
  return new;
end;
$$;
revoke all on function public.derive_player_weighted_elo() from public,anon,authenticated,service_role;

create or replace function public.derive_player_placement_matches()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_name text;
begin
  source_name := case when tg_op='UPDATE' then old.name else new.name end;
  select count(*)::integer + coalesce((select weight::integer from public.player_elo_legacy
    where player_name=source_name),0) into new.placement_matches
    from public.player_rounds where player_name=source_name and elo_weight=1;
  return new;
end;
$$;
revoke all on function public.derive_player_placement_matches() from public,anon,authenticated,service_role;

create or replace function public._refresh_player_daily_history(p_names text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);

  -- Insert missing (player_name, history_day) rows for eligible matches.
  insert into public.player_history(player_name, elo, rank, created_at)
  select
    m.player_name,
    m.performance_score,
    coalesce(p.rank, 999999),
    coalesce(m.played_at, m.created_at)
  from public.player_rounds m
  join public.players p on p.name = m.player_name
  where m.elo_weight > 0
    and m.performance_score is not null
    and (p_names is null or m.player_name = any(p_names))
    and not exists (
      select 1 from public.player_history h
      where h.player_name = m.player_name
        and h.history_day = ((coalesce(m.played_at, m.created_at) at time zone 'Europe/Berlin')::date)
    );

  -- Update all daily aggregates from player_matches (sum of performance_score / match count).
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
    from public.player_rounds
    where elo_weight > 0
      and performance_score is not null
      and (p_names is null or player_name = any(p_names))
    group by player_name, ((coalesce(played_at, created_at) at time zone 'Europe/Berlin')::date)
  ) m
  where h.player_name = m.player_name
    and h.history_day = m.match_day
    and (h.elo is distinct from m.avg_elo or h.elo_sum is distinct from m.total_score or h.elo_samples is distinct from m.match_count);

  -- Mark stale non-match history days with 0 samples for players whose history is backed by player_matches.
  update public.player_history h
  set elo_sum = 0,
      elo_samples = 0
  where (p_names is null or h.player_name = any(p_names))
    and coalesce(h.elo_samples, 1) > 0
    and exists (
      select 1 from public.player_rounds m2
      where m2.player_name = h.player_name
        and m2.elo_weight > 0
        and m2.performance_score is not null
    )
    and not exists (
      select 1 from public.player_rounds m
      where m.player_name = h.player_name
        and m.elo_weight > 0
        and m.performance_score is not null
        and ((coalesce(m.played_at, m.created_at) at time zone 'Europe/Berlin')::date) = h.history_day
    );
end;
$$;
revoke all on function public._refresh_player_daily_history(text[]) from public, anon, authenticated, service_role;

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
  -- Insert one sample per eligible round, combining a player's sessions in that round.
  insert into public.player_history(player_name, elo, rank, created_at)
    select r.player_name, r.performance_score, coalesce(p.rank, 999999), r.played_at
    from public.player_rounds r
    join public.players p on p.name = r.player_name
    where r.match_id in (select coalesce((m.value ->> 'match_id')::uuid, legacy_match_id)
        from pg_catalog.jsonb_array_elements(p_matches) m)
      and r.performance_score is not null and r.elo_weight > 0;
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, coalesce(p_details,'') || pg_catalog.format(' Database skipped %s banned participation(s).', skipped_banned));
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

-- Lifetime match counts previously counted every session.
update public.players p set matches = p.matches - x.extra
from (select player_name, (count(*) - count(distinct match_id))::integer as extra
  from public.player_matches group by player_name having count(*) > count(distinct match_id)) x
where p.name = x.player_name;

update public.players set elo = elo, placement_matches = placement_matches where true;
select public._rerank_players_by_pb();
select public._refresh_player_daily_history();
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
