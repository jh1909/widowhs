-- Admin functionality to merge unverified player profiles as unverified Battle.net accounts.
-- Apply after 20261108182500_three_battlenet_accounts.sql.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history, public.player_elo_legacy in share row exclusive mode;

create or replace function public.admin_merge_players(p_target_name text, p_source_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target public.players%rowtype;
  source public.players%rowtype;
  transferred_matches integer := 0;
  total_matches integer := 0;
  total_score integer := 0;
  total_deaths integer := 0;
  total_crouches integer := 0;
  total_time numeric := 0;
  kdr_sum numeric := 0;
  acc_sum numeric := 0;
  kpm_sum numeric := 0;
  avg_kdr text;
  avg_acc text;
  avg_kpm text;
  target_bnet_accounts jsonb;
  all_aliases text[];
begin
  if actor is null or not exists (
    select 1 from public.players where user_id = actor and is_admin is true
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
  get diagnostics transferred_matches = row_count;

  -- 2. Move history
  update public.player_history set player_name = target.name where player_name = source.name;

  -- 3. Move legacy ELO baseline if any
  insert into public.player_elo_legacy(player_name, weight, kpm_sum, accuracy_sum, kdr_sum)
    select target.name, weight, kpm_sum, accuracy_sum, kdr_sum from public.player_elo_legacy where player_name = source.name
    on conflict(player_name) do update set
      weight = public.player_elo_legacy.weight + excluded.weight,
      kpm_sum = public.player_elo_legacy.kpm_sum + excluded.kpm_sum,
      accuracy_sum = public.player_elo_legacy.accuracy_sum + excluded.accuracy_sum,
      kdr_sum = public.player_elo_legacy.kdr_sum + excluded.kdr_sum;
  delete from public.player_elo_legacy where player_name = source.name;

  -- 4. Build merged bnet_accounts (links source as unverified Battle.net account on target)
  select coalesce(pg_catalog.jsonb_agg(a), '[]'::jsonb) into target_bnet_accounts
  from (
    select distinct a from (
      select a from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(target.bnet_accounts), '[]'::jsonb)) a
      union all
      select a from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(source.bnet_accounts), '[]'::jsonb)) a
      union all
      select source.name
    ) sub(a) where pg_catalog.lower(a) <> pg_catalog.lower(target.name) and a <> ''
  ) s;

  if pg_catalog.jsonb_array_length(target_bnet_accounts) > 3 then
    raise exception 'Target player would exceed the maximum of 3 Battle.net accounts.' using errcode = '22023';
  end if;

  -- 5. Collect all aliases for previous_names
  select array(
    select distinct a from unnest(
      coalesce(target.previous_names, '{}'::text[]) ||
      coalesce(source.previous_names, '{}'::text[]) ||
      array[source.name]
    ) a where pg_catalog.lower(a) <> pg_catalog.lower(target.name) and a <> ''
  ) into all_aliases;

  -- 6. Delete source player
  delete from public.players where name = source.name;

  -- 7. Recalculate lifetime stats for target
  select count(*)::integer,
         coalesce(sum(score), 0)::integer,
         coalesce(sum(deaths), 0)::integer,
         coalesce(sum(crouches), 0)::integer,
         coalesce(sum(time_in_lobby), 0)::numeric,
         coalesce(sum(kdr), 0)::numeric,
         coalesce(sum(accuracy), 0)::numeric,
         coalesce(sum(kpm), 0)::numeric
    into total_matches, total_score, total_deaths, total_crouches, total_time,
         kdr_sum, acc_sum, kpm_sum
    from public.player_matches where player_name = target.name;

  avg_kdr := case when total_matches > 0 then round(kdr_sum / total_matches, 2)::text else '-' end;
  avg_acc := case when total_matches > 0 then round(acc_sum / total_matches, 2)::text || '%' else '-' end;
  avg_kpm := case when total_matches > 0 then round(kpm_sum / total_matches, 2)::text else '-' end;

  -- 8. Update target player row (converts jsonb target_bnet_accounts into player column type)
  target := pg_catalog.jsonb_populate_record(target, pg_catalog.jsonb_build_object('bnet_accounts', target_bnet_accounts));

  update public.players set
    matches = total_matches,
    score = total_score,
    deaths = total_deaths,
    crouches = total_crouches,
    time_in_lobby = total_time,
    kdr = avg_kdr,
    accuracy = avg_acc,
    kpm = avg_kpm,
    bnet_accounts = target.bnet_accounts,
    previous_names = all_aliases,
    elo = elo
  where name = target.name
  returning * into target;

  -- 9. Re-rank
  perform public._rerank_players_by_pb();
  update public.leaderboard_state set revision = revision + 1 where singleton;

  -- 10. Audit log
  insert into public.audit_logs(action, admin_user, details) values (
    'MERGE_PLAYERS',
    actor::text,
    pg_catalog.format('Merged unverified player %s as unverified Battle.net account into %s (%s matches transferred).',
      source.name, target.name, transferred_matches)
  );

  return pg_catalog.jsonb_build_object(
    'target_name', target.name,
    'source_name', source.name,
    'transferred_matches', transferred_matches,
    'matches', target.matches,
    'bnet_accounts', to_jsonb(target.bnet_accounts),
    'elo', target.elo,
    'rank', target.rank
  );
end;
$$;
revoke all on function public.admin_merge_players(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_merge_players(text, text) to authenticated;

commit;
