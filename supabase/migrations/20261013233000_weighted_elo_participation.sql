-- Requires the PB rankings and daily ELO history migrations.
-- The raw round rating and ordinary player statistics remain unchanged.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

create or replace function public.match_elo_weight(p_kills numeric, p_time numeric, p_total numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case when p_total is null or p_total - p_time <= 10 or p_kills >= 35 or p_time >= 180 then 1
    when p_kills < 15 and p_time < 60 then 0
    else least(1, greatest(p_kills / 35, p_time / 180)) end;
$$;
revoke all on function public.match_elo_weight(numeric,numeric,numeric) from public;
grant execute on function public.match_elo_weight(numeric,numeric,numeric) to anon, authenticated, service_role;

alter table public.player_matches add column if not exists elo_weight numeric
  generated always as (public.match_elo_weight(score::numeric,time_in_lobby::numeric,total_match_time::numeric)) stored;
alter table public.players add column if not exists elo_weight_sum numeric not null default 0;
alter table public.players add column if not exists elo_kpm_sum numeric not null default 0;
alter table public.players add column if not exists elo_accuracy_sum numeric not null default 0;
alter table public.players add column if not exists elo_kdr_sum numeric not null default 0;

-- Some old profiles have aggregate statistics without complete raw logs.
-- Preserve that unrecoverable portion at weight 1, once; never invent rounds.
create table if not exists public.player_elo_legacy (
  player_name text primary key references public.players(name) on update cascade on delete cascade,
  weight numeric not null, kpm_sum numeric not null, accuracy_sum numeric not null, kdr_sum numeric not null
);
alter table public.player_elo_legacy enable row level security;
revoke all on public.player_elo_legacy from public, anon, authenticated, service_role;
insert into public.player_elo_legacy(player_name,weight,kpm_sum,accuracy_sum,kdr_sum)
select p.name, greatest(coalesce(p.matches,0)-m.n,0),
  case when coalesce(p.matches,0)>m.n then greatest(coalesce(nullif(regexp_replace(p.kpm::text,'[^0-9.]','','g'),''),'0')::numeric*coalesce(p.matches,0)-m.kpm,0) else 0 end,
  case when coalesce(p.matches,0)>m.n then greatest(coalesce(nullif(regexp_replace(p.accuracy::text,'[^0-9.]','','g'),''),'0')::numeric*coalesce(p.matches,0)-m.acc,0) else 0 end,
  case when coalesce(p.matches,0)>m.n then greatest(coalesce(nullif(regexp_replace(p.kdr::text,'[^0-9.]','','g'),''),'0')::numeric*coalesce(p.matches,0)-m.kdr,0) else 0 end
from public.players p cross join lateral (select count(*) n, coalesce(sum(kpm),0) kpm,
  coalesce(sum(accuracy),0) acc, coalesce(sum(kdr),0) kdr from public.player_matches where player_name=p.name) m
on conflict(player_name) do nothing;

create or replace function public.derive_player_weighted_elo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_name text; rating integer;
begin
  -- On a rename the raw rows and the private baseline still use the old name.
  source_name := case when tg_op='UPDATE' then old.name else new.name end;
  select coalesce(sum(w),0),coalesce(sum(kpm),0),coalesce(sum(acc),0),coalesce(sum(kdr),0)
    into new.elo_weight_sum,new.elo_kpm_sum,new.elo_accuracy_sum,new.elo_kdr_sum
  from (
    select elo_weight w,coalesce(kpm,0)*elo_weight kpm,coalesce(accuracy,0)*elo_weight acc,
      coalesce(kdr,0)*elo_weight kdr from public.player_matches where player_name=source_name
    union all select weight,kpm_sum,accuracy_sum,kdr_sum from public.player_elo_legacy where player_name=source_name
  ) contributions;
  if new.elo_weight_sum>0 then
    rating := round((least(new.elo_kpm_sum/new.elo_weight_sum/16.67,1.67)*.65 +
      least(new.elo_accuracy_sum/new.elo_weight_sum/60,1.15)*.25 +
      least(new.elo_kdr_sum/new.elo_weight_sum,4)/3*.10)*1000);
    new.elo := pg_catalog.to_char(rating,'FM9,999,999,990');
    new.tag := case when rating>=1200 then 'PRO' else '' end;
  else
    new.elo := '-'; new.tag := ''; new.rank := 999999;
  end if;
  return new;
end;
$$;
revoke all on function public.derive_player_weighted_elo() from public,anon,authenticated,service_role;
drop trigger if exists derive_player_weighted_elo on public.players;
create trigger derive_player_weighted_elo before insert or update of name,elo,tag,
  elo_weight_sum,elo_kpm_sum,elo_accuracy_sum,elo_kdr_sum on public.players
  for each row execute function public.derive_player_weighted_elo();

-- Reuse the match statement triggers so transfers, corrections and deletions
-- refresh both PB and ELO without trusting the deployed importer's payload.
create or replace function public.refresh_match_personal_bests()
returns trigger language plpgsql security definer set search_path = '' as $$
declare names text[];
begin
  perform pg_catalog.pg_advisory_xact_lock(1909,1);
  if tg_op='INSERT' then
    select array_agg(distinct player_name) into names from new_matches;
  elsif tg_op='DELETE' then
    select array_agg(distinct player_name) into names from old_matches;
  else
    select array_agg(distinct player_name) into names from
      (select player_name from old_matches union select player_name from new_matches) affected;
  end if;
  if names is not null then
    update public.players set elo=elo where name=any(names);
    perform public._refresh_player_personal_bests(names);
    perform public._rerank_players_by_pb();
    update public.leaderboard_state set revision=revision+1 where singleton;
  end if;
  return null;
end;
$$;
revoke all on function public.refresh_match_personal_bests() from public,anon,authenticated,service_role;

-- Replacement import/link/reset functions follow below; their signatures and
-- authorization checks remain compatible with existing Edge deployments.

create or replace function public._rerank_players_by_pb()
returns void language plpgsql security definer set search_path = '' as $$
begin
  with ranked as (select name, row_number() over (order by
    replace(elo::text, ',', '')::numeric desc, personal_best_time asc nulls last,
    lower(name) collate "C", name collate "C")::integer as position
    from public.players where elo_weight_sum > 0 and replace(elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'),
  positions as (select p.name, coalesce(r.position, 999999) as position from public.players p left join ranked r on r.name = p.name)
  update public.players p set rank = r.position from positions r
    where p.name = r.name and p.rank::text is distinct from r.position::text;
end;
$$;
revoke all on function public._rerank_players_by_pb() from public, anon, authenticated, service_role;

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
      -- Only a full profile merge transfers its legacy contribution. Foreign
      -- verified takeovers move known log rows through their existing helper.
      insert into public.player_elo_legacy(player_name,weight,kpm_sum,accuracy_sum,kdr_sum)
        select target.name,weight,kpm_sum,accuracy_sum,kdr_sum from public.player_elo_legacy where player_name=donor.name
        on conflict(player_name) do update set weight=public.player_elo_legacy.weight+excluded.weight,
          kpm_sum=public.player_elo_legacy.kpm_sum+excluded.kpm_sum,
          accuracy_sum=public.player_elo_legacy.accuracy_sum+excluded.accuracy_sum,
          kdr_sum=public.player_elo_legacy.kdr_sum+excluded.kdr_sum;
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
  perform public._rerank_players_by_pb();
  if not p_remove then
    insert into public.player_history (player_name, elo, rank)
      select name, replace(elo::text, ',', '')::integer, rank from public.players
      where name = target.name and elo_weight_sum > 0;
  end if;
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs (action, admin_user, details) values ('LINK_BNET_ACCOUNT', actor::text,
    pg_catalog.format('%s account %s on %s.', case when p_remove then 'Removed' else 'Linked' end, account, target.name));
  select * into target from public.players where name = target.name;
  return pg_catalog.to_jsonb(target);
end;
$$;
revoke all on function public._link_bnet_account_impl(uuid, text, text, boolean) from public, anon, authenticated, service_role;


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
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select revision into current_revision from public.leaderboard_state where singleton for update;
  if current_revision is null or current_revision is distinct from p_expected_revision then
    raise exception 'Leaderboard changed during upload. Please import the files again.' using errcode = '40001';
  end if;
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
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, p_details);
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

create or replace function public.reset_leaderboard(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  reset_players bigint;
  deleted_matches bigint;
  deleted_history bigint;
begin
  if actor is null or not exists (
    select 1 from public.players where user_id = actor and is_admin is true
  ) then
    raise exception 'Only administrators can reset the leaderboard.' using errcode = '42501';
  end if;
  if p_confirmation is distinct from 'RESET' then
    raise exception 'Type RESET to confirm.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select name into actor_name from public.players
    where user_id = actor and is_admin is true limit 1;
  if actor_name is null then
    raise exception 'Administrator permission has been revoked.' using errcode = '42501';
  end if;

  delete from public.player_elo_legacy where true;
  delete from public.player_matches where true;
  get diagnostics deleted_matches = row_count;
  delete from public.player_history where true;
  get diagnostics deleted_history = row_count;

  update public.players set matches = 0, score = 0, deaths = 0,
    kdr = '-', accuracy = '-', kpm = '-', crouches = 0, time_in_lobby = 0,
    elo = '-', rank = 999999, tag = '' where true;
  get diagnostics reset_players = row_count;
  update public.leaderboard_state set revision = revision + 1 where singleton;

  insert into public.audit_logs (action, admin_user, details) values (
    'RESET_LEADERBOARD', actor_name,
    pg_catalog.format('Reset %s profiles; removed %s matches and %s ELO history entries. Actor: %s.',
      reset_players, deleted_matches, deleted_history, actor)
  );

  return pg_catalog.jsonb_build_object('players', reset_players,
    'matches', deleted_matches, 'history', deleted_history);
end;
$$;
revoke all on function public.reset_leaderboard(text) from public, anon;
grant execute on function public.reset_leaderboard(text) to authenticated;


-- Recalculate only derived current ratings. Existing daily history describes
-- past ratings and is retained. Record this recalibration once if ELO changed.
create temporary table weighted_elo_before on commit drop as select name,elo from public.players;
update public.players set elo=elo where true;
select public._rerank_players_by_pb();
insert into public.player_history(player_name,elo,rank)
  select p.name,replace(p.elo::text,',','')::integer,p.rank from public.players p
  join weighted_elo_before old on old.name=p.name
  where p.elo_weight_sum>0 and p.elo is distinct from old.elo;
update public.leaderboard_state set revision=revision+1 where singleton;
notify pgrst,'reload schema';
commit;
select 'Weighted profile ELO active; raw round ratings preserved' as status;
