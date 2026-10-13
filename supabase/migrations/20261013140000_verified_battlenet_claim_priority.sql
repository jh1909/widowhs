-- Apply after 20261013010000_battlenet_owned_profile_claims.sql.
-- An OAuth proof beats an unverified log-name reservation, never another proof.
-- Installation replaces functions only. Claims change on the next OAuth finish.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

create or replace function public._release_unverified_bnet_name(p_actor uuid, p_target_name text, p_account text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target public.players%rowtype;
  donor public.players%rowtype;
  stats public.players%rowtype;
  moved record;
  adjustment record;
  accounts jsonb;
  candidate text;
  original_name text;
  suffix integer;
  count_after integer;
  avg_kdr numeric; avg_acc numeric; avg_kpm numeric; rating integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select * into target from public.players where name = p_target_name and user_id = p_actor for update;
  if not found then raise exception 'Open your own Discord profile first.' using errcode = '42501'; end if;
  if exists (select 1 from public.battlenet_account_links where lower(log_name) = lower(p_account) and user_id <> p_actor) then
    raise exception 'This Battle.net name is already verified by another user.' using errcode = '23505';
  end if;

  -- Unclaimed imports and same-owner duplicates use the established full merge.
  -- A foreign Discord profile is never deleted, taken over, or granted to actor.
  for donor in select * from public.players p where p.name <> target.name
    and p.user_id is distinct from p_actor and (p.user_id is not null or p.is_admin is true)
    and (lower(p.name) = lower(p_account)
      or exists (select 1 from unnest(p.previous_names) a where lower(a) = lower(p_account))
      or exists (select 1 from jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts), '[]'::jsonb)) a where lower(a) = lower(p_account)))
    order by p.name
  loop
    original_name := donor.name;
    if lower(donor.name) = lower(p_account) then
      suffix := 0;
      loop
        suffix := suffix + 1;
        candidate := original_name || ' (profile ' || suffix || ')';
        exit when not exists (select 1 from public.players p where lower(p.name) = lower(candidate)
          or exists (select 1 from unnest(p.previous_names) a where lower(a) = lower(candidate))
          or exists (select 1 from jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts), '[]'::jsonb)) a where lower(a) = lower(candidate)));
      end loop;
      -- The existing rename trigger preserves matches/history under the new name.
      update public.players set name = candidate where name = donor.name returning * into donor;
    end if;
    select coalesce(jsonb_agg(a), '[]'::jsonb) into accounts
      from jsonb_array_elements_text(coalesce(to_jsonb(donor.bnet_accounts), '[]'::jsonb)) a where lower(a) <> lower(p_account);
    donor := jsonb_populate_record(donor, jsonb_build_object('bnet_accounts', accounts));
    -- Remove only the displaced name, including the alias added by a rename.
    update public.players set bnet_accounts = donor.bnet_accounts,
      previous_names = array(select a from unnest(donor.previous_names) a where lower(a) <> lower(p_account))
      where name = donor.name returning * into donor;

    select count(*)::integer as n, coalesce(sum(score), 0) as kills, coalesce(sum(deaths), 0) as deaths,
      coalesce(sum(crouches), 0) as crouches, coalesce(sum(time_in_lobby), 0) as lobby_time,
      coalesce(sum(kdr), 0) as kdr_sum, coalesce(sum(accuracy), 0) as acc_sum, coalesce(sum(kpm), 0) as kpm_sum
      into moved from public.player_matches
      where player_name = donor.name and lower(logged_player_name) = lower(p_account);
    if moved.n > 0 then
      -- Preserve raw names, round IDs and timestamps; move only attributable rows.
      update public.player_matches set player_name = target.name
        where player_name = donor.name and lower(logged_player_name) = lower(p_account);
      for adjustment in select * from (values (donor.name, -1), (target.name, 1)) as changes(player_name, direction)
      loop
        select * into stats from public.players where name = adjustment.player_name;
        count_after := coalesce(stats.matches, 0) + adjustment.direction * moved.n;
        if count_after < 0 then raise exception 'Match statistics need reconciliation before linking.' using errcode = '40001'; end if;
        avg_kdr := greatest(coalesce(nullif(stats.kdr::text, '-'), '0')::numeric * coalesce(stats.matches, 0)
          + adjustment.direction * moved.kdr_sum, 0) / greatest(count_after, 1);
        avg_acc := greatest(coalesce(nullif(replace(stats.accuracy::text, '%', ''), '-'), '0')::numeric * coalesce(stats.matches, 0)
          + adjustment.direction * moved.acc_sum, 0) / greatest(count_after, 1);
        avg_kpm := greatest(coalesce(nullif(stats.kpm::text, '-'), '0')::numeric * coalesce(stats.matches, 0)
          + adjustment.direction * moved.kpm_sum, 0) / greatest(count_after, 1);
        rating := round((least(avg_kpm / 16.67, 1.67) * .65 + least(avg_acc / 60, 1.15) * .25 + least(avg_kdr, 4) / 3 * .10) * 1000);
        update public.players set matches = count_after,
          score = greatest(coalesce(stats.score, 0) + adjustment.direction * moved.kills, 0),
          deaths = greatest(coalesce(stats.deaths, 0) + adjustment.direction * moved.deaths, 0),
          crouches = greatest(coalesce(stats.crouches, 0) + adjustment.direction * moved.crouches, 0),
          time_in_lobby = greatest(coalesce(stats.time_in_lobby, 0) + adjustment.direction * moved.lobby_time, 0),
          kdr = case when count_after > 0 then round(avg_kdr, 2)::text else '-' end,
          accuracy = case when count_after > 0 then round(avg_acc, 2)::text || '%' else '-' end,
          kpm = case when count_after > 0 then round(avg_kpm, 2)::text else '-' end,
          elo = case when count_after > 0 then to_char(rating, 'FM9,999,999,990') else '-' end,
          rank = 999999, tag = case when rating >= 1200 and count_after > 0 then 'PRO' else '' end
          where name = stats.name;
      end loop;
    end if;
    -- Mixed historical ELO snapshots remain on their original Discord profile.
    insert into public.audit_logs(action, admin_user, details) values ('RELEASE_UNVERIFIED_BNET_NAME', p_actor::text,
      format('Released unverified name %s from %s; moved %s attributable matches to %s.', p_account, original_name, moved.n, target.name));
  end loop;
end;
$$;
revoke all on function public._release_unverified_bnet_name(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.complete_battlenet_account_link(p_user_id uuid, p_account_id text, p_battletag text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target public.players%rowtype;
  existing public.battlenet_account_links%rowtype;
  account text := split_part(p_battletag, '#', 1);
begin
  if p_account_id is null or p_account_id !~ '^[0-9]{1,30}$'
    or p_battletag is null or p_battletag !~ '^[^#[:space:]][^#\r\n]{0,63}#[0-9]{3,12}$'
    or btrim(account) <> account then
    raise exception 'Invalid Battle.net identity.' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.identities where user_id = p_user_id and provider = 'discord') then
    raise exception 'A Discord profile is required.' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select * into target from public.players where user_id = p_user_id order by matches desc nulls last, name asc limit 1 for update;
  if not found then raise exception 'Open your Discord profile first.' using errcode = '42501'; end if;
  select * into existing from public.battlenet_account_links where issuer = 'https://oauth.battle.net' and account_id = p_account_id for update;
  if found and existing.user_id <> p_user_id then
    raise exception 'This Battle.net account is already linked to another user.' using errcode = '23505';
  end if;
  if exists (select 1 from public.battlenet_account_links where lower(log_name) = lower(account)
    and (account_id <> p_account_id or user_id <> p_user_id)) then
    raise exception 'This Battle.net name is already verified by another account.' using errcode = '23505';
  end if;
  -- Proof of this particular Battle.net name outranks imported/display/manual
  -- reservations. A badge for an unrelated account does not reserve this name.
  perform public._release_unverified_bnet_name(p_user_id, target.name, account);
  select * into target from public.players where name = target.name;
  if existing.account_id is not null and lower(existing.log_name) <> lower(account) then
    delete from public.battlenet_account_links where issuer = existing.issuer and account_id = existing.account_id;
    update public.players set previous_names = array(select distinct a from unnest(previous_names || array[existing.log_name]) a)
      where name = target.name;
    perform public._link_bnet_account_impl(p_user_id, target.name, existing.log_name, true);
    select * into target from public.players where name = target.name;
  end if;
  if not exists (select 1 from jsonb_array_elements_text(coalesce(to_jsonb(target.bnet_accounts), '[]'::jsonb)) a
    where lower(a) = lower(account)) then
    perform public._link_bnet_account_impl(p_user_id, target.name, account, false);
  end if;
  insert into public.battlenet_account_links(issuer, account_id, user_id, battletag, log_name)
    values ('https://oauth.battle.net', p_account_id, p_user_id, p_battletag, account)
    on conflict (issuer, account_id) do update set battletag = excluded.battletag,
      log_name = excluded.log_name, verified_at = now();
  update public.players set is_verified = is_verified where user_id = p_user_id;
  -- Also rerank when reverifying an existing manual slot displaced another profile.
  with ranked as (select name, row_number() over (order by
    replace(elo::text, ',', '')::numeric desc, lower(name) collate "C", name collate "C")::integer as position
    from public.players where coalesce(matches, 0) > 0 and replace(elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$')
  update public.players p set rank = r.position from ranked r where p.name = r.name;
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs(action, admin_user, details) values ('VERIFY_BNET_ACCOUNT', p_user_id::text,
    format('Verified Battle.net name %s on %s.', account, target.name));
end;
$$;
revoke all on function public.complete_battlenet_account_link(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_battlenet_account_link(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
select 'Verified Battle.net accounts now outrank unverified name reservations' as status;
