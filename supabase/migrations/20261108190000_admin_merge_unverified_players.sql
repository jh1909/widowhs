-- Admin functionality to merge unverified player profiles as unverified Battle.net accounts.
-- Apply after 20261108182500_three_battlenet_accounts.sql.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history, public.player_elo_legacy in share row exclusive mode;

create or replace function public.admin_merge_players(p_target_name text, p_source_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  target public.players%rowtype;
  source public.players%rowtype;
  v_transferred_matches integer := 0;
  v_total_matches integer := 0;
  v_total_score integer := 0;
  v_total_deaths integer := 0;
  v_total_crouches integer := 0;
  v_total_time numeric := 0;
  v_kdr_sum numeric := 0;
  v_acc_sum numeric := 0;
  v_kpm_sum numeric := 0;
  v_avg_kdr text;
  v_avg_acc text;
  v_avg_kpm text;
  v_target_bnet_accounts jsonb;
  v_all_aliases text[];
begin
  if v_actor is null or not exists (
    select 1 from public.players where user_id = v_actor and is_admin is true
  ) then
    raise exception 'Only administrators may merge player profiles.' using errcode = '42501';
  end if;

  if p_target_name is null or pg_catalog.btrim(p_target_name) = '' or
     p_source_name is null or pg_catalog.btrim(p_source_name) = '' then
    raise exception 'Target and source player names are required.' using errcode = '22023';
  end if;

  if pg_catalog.lower(pg_catalog.btrim(p_target_name)) = pg_catalog.lower(pg_catalog.btrim(p_source_name)) then
    raise exception 'Cannot merge a player into themselves.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_matches, public.player_history, public.player_elo_legacy in share row exclusive mode;

  select * into target from public.players where pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_target_name)) for update;
  if not found then
    raise exception 'Target player % does not exist.', p_target_name using errcode = '22023';
  end if;

  select * into source from public.players where pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_source_name)) for update;
  if not found then
    raise exception 'Source player % does not exist.', p_source_name using errcode = '22023';
  end if;

  if coalesce(source.is_verified, false) is true or source.user_id is not null or exists (
    select 1 from public.battlenet_account_links where pg_catalog.lower(log_name) = pg_catalog.lower(source.name)
  ) then
    raise exception 'Only unverified accounts without a linked Discord or Battle.net account can be merged.' using errcode = '42501';
  end if;

  if coalesce(source.is_banned, false) is true then
    raise exception 'Cannot merge a banned player. Unban the player first if this merge is intentional.' using errcode = '42501';
  end if;

  -- 1. Move matches
  update public.player_matches set player_name = target.name where player_name = source.name;
  get diagnostics v_transferred_matches = row_count;

  -- 2. Move history
  update public.player_history set player_name = target.name where player_name = source.name;

  -- 3. Move legacy ELO baseline if any
  insert into public.player_elo_legacy(player_name, weight, kpm_sum, accuracy_sum, kdr_sum)
    select target.name, l.weight, l.kpm_sum, l.accuracy_sum, l.kdr_sum
    from public.player_elo_legacy l where l.player_name = source.name
    on conflict(player_name) do update set
      weight = public.player_elo_legacy.weight + excluded.weight,
      kpm_sum = public.player_elo_legacy.kpm_sum + excluded.kpm_sum,
      accuracy_sum = public.player_elo_legacy.accuracy_sum + excluded.accuracy_sum,
      kdr_sum = public.player_elo_legacy.kdr_sum + excluded.kdr_sum;
  delete from public.player_elo_legacy where player_name = source.name;

  -- 4. Build merged bnet_accounts (links master + source as unverified Battle.net accounts on target)
  select coalesce(pg_catalog.jsonb_agg(a order by case when pg_catalog.lower(a) = pg_catalog.lower(target.name) then 0 else 1 end, a), '[]'::jsonb)
  into v_target_bnet_accounts
  from (
    select distinct a from (
      select target.name as a
      union all
      select a from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(target.bnet_accounts), '[]'::jsonb)) a
      union all
      select a from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(source.bnet_accounts), '[]'::jsonb)) a
      union all
      select source.name as a
    ) sub(a) where a is not null and pg_catalog.btrim(a) <> ''
  ) s;

  if pg_catalog.jsonb_array_length(v_target_bnet_accounts) > 3 then
    raise exception 'Target player would exceed the maximum of 3 Battle.net accounts.' using errcode = '22023';
  end if;

  -- 5. Collect all aliases for previous_names
  select array(
    select distinct a from unnest(
      coalesce(target.previous_names, '{}'::text[]) ||
      coalesce(source.previous_names, '{}'::text[]) ||
      array[source.name]
    ) a where pg_catalog.lower(a) <> pg_catalog.lower(target.name) and a <> ''
  ) into v_all_aliases;

  -- 6. Delete source player
  delete from public.players where name = source.name;

  -- 7. Recalculate lifetime stats for target
  select count(*)::integer,
         coalesce(sum(m.score), 0)::integer,
         coalesce(sum(m.deaths), 0)::integer,
         coalesce(sum(m.crouches), 0)::integer,
         coalesce(sum(m.time_in_lobby), 0)::numeric,
         coalesce(sum(m.kdr), 0)::numeric,
         coalesce(sum(m.accuracy), 0)::numeric,
         coalesce(sum(m.kpm), 0)::numeric
    into v_total_matches, v_total_score, v_total_deaths, v_total_crouches, v_total_time,
         v_kdr_sum, v_acc_sum, v_kpm_sum
    from public.player_matches m where m.player_name = target.name;

  v_avg_kdr := case when v_total_matches > 0 then round(v_kdr_sum / v_total_matches, 2)::text else '-' end;
  v_avg_acc := case when v_total_matches > 0 then round(v_acc_sum / v_total_matches, 2)::text || '%' else '-' end;
  v_avg_kpm := case when v_total_matches > 0 then round(v_kpm_sum / v_total_matches, 2)::text else '-' end;

  -- 8. Update target player row (converts jsonb v_target_bnet_accounts into player column type)
  target := pg_catalog.jsonb_populate_record(target, pg_catalog.jsonb_build_object('bnet_accounts', v_target_bnet_accounts));

  update public.players set
    matches = v_total_matches,
    score = v_total_score,
    deaths = v_total_deaths,
    crouches = v_total_crouches,
    time_in_lobby = v_total_time,
    kdr = v_avg_kdr,
    accuracy = v_avg_acc,
    kpm = v_avg_kpm,
    bnet_accounts = target.bnet_accounts,
    previous_names = v_all_aliases,
    elo = elo
  where name = target.name
  returning * into target;

  -- 9. Re-rank
  perform public._rerank_players_by_pb();
  update public.leaderboard_state set revision = revision + 1 where singleton;

  -- 10. Audit log
  insert into public.audit_logs(action, admin_user, details) values (
    'MERGE_PLAYERS',
    v_actor::text,
    pg_catalog.format('Merged unverified player %s as unverified Battle.net account into %s (%s matches transferred).',
      source.name, target.name, v_transferred_matches)
  );

  return pg_catalog.jsonb_build_object(
    'target_name', target.name,
    'source_name', source.name,
    'transferred_matches', v_transferred_matches,
    'matches', target.matches,
    'bnet_accounts', to_jsonb(target.bnet_accounts),
    'elo', target.elo,
    'rank', target.rank
  );
end;
$$;
revoke all on function public.admin_merge_players(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_merge_players(text, text) to authenticated;

create or replace function public.get_player_bnet_accounts(p_player_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_player public.players%rowtype;
  v_accounts jsonb;
begin
  select * into v_player from public.players where pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_player_name));
  if not found then
    return '[]'::jsonb;
  end if;

  v_accounts := coalesce(pg_catalog.to_jsonb(v_player.bnet_accounts), '[]'::jsonb);

  -- If player is unverified without a linked Discord account, ensure the master player name is included
  if v_player.user_id is null and coalesce(v_player.is_verified, false) is false then
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(v_accounts) a
      where pg_catalog.lower(a) = pg_catalog.lower(v_player.name)
    ) then
      v_accounts := pg_catalog.jsonb_build_array(v_player.name) || v_accounts;
    end if;
  end if;

  return (
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', a.name,
        'battletag', l.battletag,
        'verified', l.account_id is not null
      ) order by a.ordinality
    ), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements_text(v_accounts) with ordinality a(name, ordinality)
    left join public.battlenet_account_links l on l.user_id = v_player.user_id and pg_catalog.lower(l.log_name) = pg_catalog.lower(a.name)
  );
end;
$$;
revoke all on function public.get_player_bnet_accounts(text) from public;
grant execute on function public.get_player_bnet_accounts(text) to anon, authenticated, service_role;

commit;
