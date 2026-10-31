-- Batch player_matches inserts and rank updates inside apply_match_import so
-- statement triggers on player_matches fire once per import instead of once per
-- participant row.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

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
  -- Read bans under the same lock/revision as the import. Protect older Edge
  -- deployments as well as the new importer, including canonical and alias names.
  select coalesce(array_agg(distinct lower(btrim(a.alias))), '{}'::text[]) into banned_names
  from public.players p cross join lateral (
    select p.name as alias
    union all select unnest(p.previous_names)
    union all select jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts),'[]'::jsonb))
  ) a where p.is_banned is true;
  -- If a legacy payload resolves a blocked log name to another canonical name,
  -- skip that aggregate too rather than saving its precomputed banned stats.
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
  -- One snapshot per affected player/upload, only if the upload contributes
  -- eligible weight. Old importers may still supply excluded history entries.
  insert into public.player_history(player_name,elo,rank)
    select p.name,replace(p.elo::text,',','')::integer,p.rank from public.players p
    where p.elo_weight_sum>0 and exists(select 1 from pg_catalog.jsonb_array_elements(p_matches) m
      where m->>'player_name'=p.name and public.match_elo_weight((m->>'score')::numeric,
        (m->>'time_in_lobby')::numeric,(m->>'total_match_time')::numeric)>0);
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, coalesce(p_details,'') || pg_catalog.format(' Database skipped %s banned participation(s).', skipped_banned));
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
