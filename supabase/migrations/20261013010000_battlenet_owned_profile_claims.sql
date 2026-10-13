-- Apply after 20261012220000_battlenet_oauth.sql.
-- Own legacy profiles/aliases must not block their Discord owner's OAuth proof.
-- Foreign claims remain protected; existing data changes only on an authorized link.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
create or replace function public._link_bnet_account_impl(p_actor uuid, p_player_name text, p_account text, p_remove boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := p_actor;
  target public.players%rowtype;
  donor public.players%rowtype;
  account text := pg_catalog.btrim(pg_catalog.split_part(p_account, '#', 1));
  accounts jsonb;
  donor_account text;
  merged_count integer;
  avg_kdr numeric; avg_acc numeric; avg_kpm numeric; rating integer;
begin
  if actor is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if account is null or account = '' then raise exception 'Enter a Battle.net name.' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select * into target from public.players where name = p_player_name for update;
  if not found or (target.user_id is distinct from actor and not exists
    (select 1 from public.players where user_id = actor and is_admin is true)) then
    raise exception 'You may only link accounts to your own profile.' using errcode = '42501';
  end if;
  if target.user_id is null then raise exception 'This profile needs a Discord account first.' using errcode = '22023'; end if;
  accounts := coalesce(pg_catalog.to_jsonb(target.bnet_accounts), '[]'::jsonb);
  if p_remove then
    select coalesce(pg_catalog.jsonb_agg(a), '[]'::jsonb) into accounts
      from pg_catalog.jsonb_array_elements_text(accounts) a where pg_catalog.lower(a) <> pg_catalog.lower(account);
  else
    if exists (select 1 from pg_catalog.jsonb_array_elements_text(accounts) a where pg_catalog.lower(a) = pg_catalog.lower(account)) then
      raise exception 'This account is already linked.' using errcode = '23505';
    end if;
    if pg_catalog.jsonb_array_length(accounts) >= 2 then raise exception 'Maximum of 2 Battle.net accounts.' using errcode = '22023'; end if;
    if exists (select 1 from public.players p where p.name <> target.name
      and p.user_id is distinct from target.user_id
      and (p.user_id is not null or p.is_admin is true)
      and (pg_catalog.lower(p.name) = pg_catalog.lower(account)
        or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(account))
        or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
          where pg_catalog.lower(a) = pg_catalog.lower(account)))) then
      raise exception 'This Battle.net name belongs to another linked profile.' using errcode = '23505';
    end if;
    accounts := accounts || pg_catalog.jsonb_build_array(account);
    for donor in select * from public.players p where p.name <> target.name
      and ((p.user_id is null and coalesce(p.is_admin, false) = false) or p.user_id = target.user_id)
      and (pg_catalog.lower(p.name) = pg_catalog.lower(account)
        or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(account))
        or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
          where pg_catalog.lower(a) = pg_catalog.lower(account)))
    loop
      -- A legacy profile belonging to this same Discord user is not a foreign
      -- claim. Preserve its other linked names as well as its stats/history.
      if donor.user_id = target.user_id then
        for donor_account in select a from pg_catalog.jsonb_array_elements_text(
          coalesce(pg_catalog.to_jsonb(donor.bnet_accounts), '[]'::jsonb)) a
        loop
          if not exists (select 1 from pg_catalog.jsonb_array_elements_text(accounts) a
            where pg_catalog.lower(a) = pg_catalog.lower(donor_account)) then
            accounts := accounts || pg_catalog.jsonb_build_array(donor_account);
          end if;
        end loop;
        if pg_catalog.jsonb_array_length(accounts) > 2 then
          raise exception 'Maximum of 2 Battle.net accounts.' using errcode = '22023';
        end if;
      end if;
      merged_count := coalesce(target.matches, 0) + coalesce(donor.matches, 0);
      avg_kdr := (coalesce(nullif(target.kdr::text, '-'), '0')::numeric * coalesce(target.matches, 0)
        + coalesce(nullif(donor.kdr::text, '-'), '0')::numeric * coalesce(donor.matches, 0)) / greatest(merged_count, 1);
      avg_acc := (coalesce(nullif(replace(target.accuracy::text, '%', ''), '-'), '0')::numeric * coalesce(target.matches, 0)
        + coalesce(nullif(replace(donor.accuracy::text, '%', ''), '-'), '0')::numeric * coalesce(donor.matches, 0)) / greatest(merged_count, 1);
      avg_kpm := (coalesce(nullif(target.kpm::text, '-'), '0')::numeric * coalesce(target.matches, 0)
        + coalesce(nullif(donor.kpm::text, '-'), '0')::numeric * coalesce(donor.matches, 0)) / greatest(merged_count, 1);
      rating := round((least(avg_kpm / 16.67, 1.67) * .65 + least(avg_acc / 60, 1.15) * .25 + least(avg_kdr, 4) / 3 * .10) * 1000);
      update public.player_matches set player_name = target.name where player_name = donor.name;
      update public.player_history set player_name = target.name where player_name = donor.name;
      delete from public.players where name = donor.name;
      update public.players set is_admin = coalesce(target.is_admin, false) or coalesce(donor.is_admin, false),
        matches = merged_count, score = coalesce(target.score, 0) + coalesce(donor.score, 0),
        deaths = coalesce(target.deaths, 0) + coalesce(donor.deaths, 0), crouches = coalesce(target.crouches, 0) + coalesce(donor.crouches, 0),
        time_in_lobby = coalesce(target.time_in_lobby, 0) + coalesce(donor.time_in_lobby, 0),
        kdr = round(avg_kdr, 2)::text, accuracy = round(avg_acc, 2)::text || '%', kpm = round(avg_kpm, 2)::text,
        elo = case when merged_count > 0 then pg_catalog.to_char(rating, 'FM9,999,999,990') else '-' end,
        tag = case when rating >= 1200 and merged_count > 0 then 'PRO' else '' end,
        previous_names = array(select distinct a from pg_catalog.unnest(target.previous_names || donor.previous_names || array[donor.name]) a)
      where name = target.name returning * into target;
    end loop;
  end if;
  -- Supports both existing text[] and jsonb account columns.
  target := pg_catalog.jsonb_populate_record(target, pg_catalog.jsonb_build_object('bnet_accounts', accounts));
  update public.players set bnet_accounts = target.bnet_accounts where name = target.name returning * into target;
  with ranked as (select name, row_number() over (order by
    replace(elo::text, ',', '')::numeric desc, lower(name) collate "C", name collate "C")::integer as position
    from public.players where coalesce(matches, 0) > 0 and replace(elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$')
  update public.players p set rank = r.position from ranked r where p.name = r.name;
  if not p_remove then
    insert into public.player_history (player_name, elo, rank)
      select name, replace(elo::text, ',', '')::integer, rank from public.players
      where name = target.name and coalesce(matches, 0) > 0;
  end if;
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs (action, admin_user, details) values ('LINK_BNET_ACCOUNT', actor::text,
    pg_catalog.format('%s account %s on %s.', case when p_remove then 'Removed' else 'Linked' end, account, target.name));
  select * into target from public.players where name = target.name;
  return pg_catalog.to_jsonb(target);
end;
$$;
revoke all on function public._link_bnet_account_impl(uuid, text, text, boolean) from public, anon, authenticated, service_role;

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
    raise exception 'This Battle.net name is already claimed.' using errcode = '23505';
  end if;
  -- Name-only workshop exports: first claimant keeps the name, including legacy
  -- manual claims. OAuth does not override someone else's profile or aliases.
  if exists (select 1 from public.players p where p.name <> target.name
    and p.user_id is distinct from p_user_id and (p.user_id is not null or p.is_admin is true)
    and (lower(p.name) = lower(account)
      or exists (select 1 from unnest(p.previous_names) a where lower(a) = lower(account))
      or exists (select 1 from jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts), '[]'::jsonb)) a where lower(a) = lower(account)))) then
    raise exception 'This Battle.net name is already claimed.' using errcode = '23505';
  end if;
  if existing.account_id is not null and lower(existing.log_name) <> lower(account) then
    -- Reauthorizing after a Blizzard name change frees its slot atomically;
    -- existing match/alias history is retained by the established merge helper.
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
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs(action, admin_user, details) values ('VERIFY_BNET_ACCOUNT', p_user_id::text,
    format('Verified Battle.net name %s on %s.', account, target.name));
end;
$$;
revoke all on function public.complete_battlenet_account_link(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_battlenet_account_link(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
select 'Own Battle.net profile claims fixed; foreign claims remain protected' as status;
