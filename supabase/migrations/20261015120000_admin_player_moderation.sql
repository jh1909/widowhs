-- Apply after the weighted ELO and fully eligible placement migrations.
-- Installing this migration does not ban or delete any player.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

alter table public.players add column if not exists is_banned boolean not null default false;

-- A banned user cannot undo the ban with a direct write to their own row.
create or replace function public.guard_player_ban()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if (tg_op = 'INSERT' and new.is_banned is true) or
      (tg_op = 'UPDATE' and new.is_banned is distinct from old.is_banned) then
      raise exception 'Use the administrator moderation function to change bans.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_player_ban() from public, anon, authenticated, service_role;
drop trigger if exists guard_player_ban on public.players;
create trigger guard_player_ban before insert or update of is_banned on public.players
  for each row execute function public.guard_player_ban();

-- Preserve ELO/PB ordering while excluding banned players from stored ranks.
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
end;
$$;
revoke all on function public._rerank_players_by_pb() from public, anon, authenticated, service_role;

create or replace function public.admin_moderate_player(p_player_name text, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target public.players%rowtype;
  deleted_matches bigint := 0;
  deleted_history bigint := 0;
begin
  -- Match the import/link/reset lock order and invalidate in-flight uploads.
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_matches, public.player_history in share row exclusive mode;
  if actor is null or not exists (
    select 1 from public.players where user_id = actor and is_admin is true
  ) then raise exception 'Only administrators may moderate players.' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('ban', 'unban', 'delete') then
    raise exception 'Unknown moderation action.' using errcode = '22023';
  end if;
  select * into target from public.players where name = p_player_name for update;
  if not found then
    raise exception 'This profile no longer exists under that name. Please reload.' using errcode = '40001';
  end if;

  if p_action = 'delete' then
    -- Explicitly remove dependent stats even on older schemas without cascading FKs.
    delete from public.player_matches where player_name = target.name;
    get diagnostics deleted_matches = row_count;
    delete from public.player_history where player_name = target.name;
    get diagnostics deleted_history = row_count;
    delete from public.player_elo_legacy where player_name = target.name;
    delete from public.players where name = target.name;
    -- Private data follows the Discord user. Keep it if another profile still
    -- belongs to that user; never remove the Discord/Supabase auth account.
    if target.user_id is not null and not exists (
      select 1 from public.players where user_id = target.user_id
    ) then
      delete from public.battlenet_oauth_requests where user_id = target.user_id;
      delete from public.battlenet_account_links where user_id = target.user_id;
      delete from public.player_profile_details where user_id = target.user_id;
    end if;
  else
    update public.players set is_banned = (p_action = 'ban') where name = target.name;
  end if;
  perform public._rerank_players_by_pb();
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs(action, admin_user, details) values (
    case p_action when 'ban' then 'BAN_PLAYER' when 'unban' then 'UNBAN_PLAYER' else 'DELETE_PLAYER' end,
    actor::text,
    case when p_action = 'delete' then pg_catalog.format('Deleted player %s, %s match participations and %s daily ELO entries.',
      target.name, deleted_matches, deleted_history)
    else pg_catalog.format('%s player %s.', case p_action when 'ban' then 'Banned' else 'Unbanned' end, target.name) end
  );
  return pg_catalog.jsonb_build_object('name', target.name, 'action', p_action,
    'deleted', p_action = 'delete', 'is_banned', case when p_action = 'delete' then null else p_action = 'ban' end);
end;
$$;
revoke all on function public.admin_moderate_player(text,text) from public, anon, authenticated, service_role;
grant execute on function public.admin_moderate_player(text,text) to authenticated;

-- Ignore banned participants before any statistics, raw rows or ELO snapshots are saved.
create or replace function public.apply_match_import(
  p_expected_revision bigint, p_players jsonb, p_ranks jsonb,
  p_history jsonb, p_matches jsonb, p_admin_user text, p_details text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  current_revision bigint;
  imported_player public.players%rowtype;
  imported_match public.player_matches%rowtype;
  match_payload jsonb;
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
  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_ranks) loop
    update public.players set rank = imported_player.rank where name = imported_player.name;
  end loop;
  for match_payload in select value from pg_catalog.jsonb_array_elements(p_matches) loop
    imported_match := pg_catalog.jsonb_populate_record(null::public.player_matches, match_payload);
    insert into public.player_matches (player_name, logged_player_name, score, deaths, accuracy, kpm, kdr,
      crouches, time_in_lobby, total_match_time, performance_score, played_at, match_id)
    values (imported_match.player_name, coalesce(imported_match.logged_player_name, imported_match.player_name),
      imported_match.score, imported_match.deaths, imported_match.accuracy, imported_match.kpm, imported_match.kdr,
      imported_match.crouches, imported_match.time_in_lobby, imported_match.total_match_time, imported_match.performance_score,
      coalesce((match_payload ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now()),
      coalesce(imported_match.match_id, legacy_match_id));
  end loop;
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

select public._rerank_players_by_pb();
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
