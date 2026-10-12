-- Requires the existing reset, rename, match-date and round-ID migrations.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_history, public.player_matches in share row exclusive mode;

alter table public.players add column if not exists is_verified boolean not null default false;
alter table public.players add column if not exists avatar_url text;
alter table public.player_matches add column if not exists logged_player_name text;
update public.player_matches set logged_player_name = player_name where logged_player_name is null;
create index if not exists player_matches_round_date_idx on public.player_matches (played_at desc, match_id);

-- Verification comes from trusted Discord identities and linked log names.
-- A browser cannot award verification, take an imported profile or grant admin.
create or replace function public.guard_player_account_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Invoker context distinguishes a direct browser write from an authorized RPC.
  if current_user in ('anon', 'authenticated') then
    if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
    if tg_op = 'INSERT' then
      if new.user_id is distinct from auth.uid() or coalesce(new.is_admin, false)
        or pg_catalog.jsonb_array_length(coalesce(pg_catalog.to_jsonb(new.bnet_accounts), '[]'::jsonb)) > 0 then
        raise exception 'Use the Discord profile and account-link functions.' using errcode = '42501';
      end if;
    elsif (old.user_id is distinct from auth.uid() and not exists
      (select 1 from public.players where user_id = auth.uid() and is_admin is true)) then
      raise exception 'You may only edit your own profile.' using errcode = '42501';
    elsif new.user_id is distinct from old.user_id
      or (new.is_admin is distinct from old.is_admin and not exists
        (select 1 from public.players where user_id = auth.uid() and is_admin is true))
      or pg_catalog.to_jsonb(new.bnet_accounts) is distinct from pg_catalog.to_jsonb(old.bnet_accounts)
      or new.previous_names is distinct from old.previous_names then
      raise exception 'Use the authorized profile functions to change account links.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_player_account_fields() from public, anon, authenticated;
drop trigger if exists guard_player_account_fields on public.players;
create trigger guard_player_account_fields before insert or update on public.players
for each row execute function public.guard_player_account_fields();
create or replace function public.maintain_player_verification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.is_verified := new.user_id is not null
    and exists (select 1 from auth.identities i where i.user_id = new.user_id and i.provider = 'discord')
    and pg_catalog.jsonb_array_length(coalesce(pg_catalog.to_jsonb(new.bnet_accounts), '[]'::jsonb)) > 0;
  return new;
end;
$$;
revoke all on function public.maintain_player_verification() from public, anon, authenticated;
drop trigger if exists maintain_player_verification on public.players;
create trigger maintain_player_verification before insert or update on public.players
for each row execute function public.maintain_player_verification();
update public.players set is_verified = is_verified where true;

create or replace function public.ensure_discord_player(p_name text, p_avatar_url text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target public.players%rowtype;
  candidate text := pg_catalog.btrim(p_name);
  suffix integer := 0;
begin
  if actor is null or not exists (select 1 from auth.identities where user_id = actor and provider = 'discord') then
    raise exception 'Please sign in with Discord.' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select * into target from public.players where user_id = actor order by matches desc nulls last limit 1 for update;
  if found then
    update public.players set avatar_url = coalesce(p_avatar_url, avatar_url) where name = target.name returning * into target;
  else
    if candidate is null or candidate = '' or pg_catalog.lower(candidate) = 'me' then candidate := 'Player'; end if;
    -- Display-name equality does not establish ownership of an imported player.
    while exists (select 1 from public.players p where pg_catalog.lower(p.name) = pg_catalog.lower(candidate)
      or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(candidate))
      or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
        where pg_catalog.lower(a) = pg_catalog.lower(candidate))) loop
      suffix := suffix + 1;
      candidate := coalesce(nullif(pg_catalog.btrim(p_name), ''), 'Player') || '_' || pg_catalog.left(actor::text, 8) || '_' || suffix;
    end loop;
    insert into public.players (name, user_id, avatar_url, is_admin, matches, score, deaths, kdr, accuracy, kpm,
      crouches, time_in_lobby, elo, rank, tag)
    values (candidate, actor, p_avatar_url, false, 0, 0, 0, '-', '-', '-', 0, 0, '-', 999999, '') returning * into target;
    update public.leaderboard_state set revision = revision + 1 where singleton;
  end if;
  return pg_catalog.jsonb_build_object('name', target.name, 'is_admin', target.is_admin, 'is_verified', target.is_verified);
end;
$$;
revoke all on function public.ensure_discord_player(text, text) from public, anon;
grant execute on function public.ensure_discord_player(text, text) to authenticated;

create or replace function public.link_bnet_account(p_player_name text, p_account text, p_remove boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target public.players%rowtype;
  donor public.players%rowtype;
  account text := pg_catalog.btrim(pg_catalog.split_part(p_account, '#', 1));
  accounts jsonb;
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
      and (p.user_id is not null or p.is_admin is true)
      and (pg_catalog.lower(p.name) = pg_catalog.lower(account)
        or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(account))
        or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
          where pg_catalog.lower(a) = pg_catalog.lower(account)))) then
      raise exception 'This Battle.net name belongs to another linked profile.' using errcode = '23505';
    end if;
    accounts := accounts || pg_catalog.jsonb_build_array(account);
    for donor in select * from public.players p where p.name <> target.name and p.user_id is null and coalesce(p.is_admin, false) = false
      and (pg_catalog.lower(p.name) = pg_catalog.lower(account)
        or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(account))
        or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
          where pg_catalog.lower(a) = pg_catalog.lower(account)))
    loop
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
      update public.players set matches = merged_count, score = coalesce(target.score, 0) + coalesce(donor.score, 0),
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
revoke all on function public.link_bnet_account(text, text, boolean) from public, anon;
grant execute on function public.link_bnet_account(text, text, boolean) to authenticated;

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
  history_entry public.player_history%rowtype;
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
  for history_entry in select * from pg_catalog.jsonb_populate_recordset(null::public.player_history, p_history) loop
    insert into public.player_history (player_name, elo, rank) values (history_entry.player_name, history_entry.elo, history_entry.rank);
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
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, p_details);
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

-- Public read-only projections deliberately exclude account IDs and auth data.
create or replace function public.get_global_matches(p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  with rounds as (
    select match_id, min(played_at) as played_at, count(*) as player_count,
      max(total_match_time) as total_match_time, sum(score) as total_kills,
      (array_agg(coalesce(logged_player_name, player_name) order by score desc, coalesce(logged_player_name, player_name) collate "C")
        filter (where score >= 50))[1] as winner
    from public.player_matches group by match_id
  ), page as (
    select * from rounds order by played_at desc, match_id desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  )
  select pg_catalog.jsonb_build_object('total', (select count(*) from rounds),
    'matches', coalesce((select jsonb_agg(to_jsonb(page) order by played_at desc, match_id desc) from page), '[]'::jsonb));
$$;
revoke all on function public.get_global_matches(integer, integer) from public;
grant execute on function public.get_global_matches(integer, integer) to anon, authenticated, service_role;

create or replace function public.get_match_details(p_match_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_name', m.player_name, 'logged_player_name', coalesce(m.logged_player_name, m.player_name),
    'avatar_url', p.avatar_url, 'is_verified', coalesce(p.is_verified, false),
    'score', m.score, 'deaths', m.deaths, 'accuracy', m.accuracy, 'kpm', m.kpm, 'kdr', m.kdr,
    'crouches', m.crouches, 'time_in_lobby', m.time_in_lobby, 'total_match_time', m.total_match_time,
    'performance_score', m.performance_score, 'played_at', m.played_at
  ) order by m.score desc, m.time_in_lobby asc, coalesce(m.logged_player_name, m.player_name) collate "C"), '[]'::jsonb)
  from public.player_matches m left join public.players p on p.name = m.player_name where m.match_id = p_match_id;
$$;
revoke all on function public.get_match_details(uuid) from public;
grant execute on function public.get_match_details(uuid) to anon, authenticated, service_role;

update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
select 'Global match history and verified profiles installed' as status;
