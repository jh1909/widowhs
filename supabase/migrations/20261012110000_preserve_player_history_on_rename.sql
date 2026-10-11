begin;

select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_history, public.player_matches in share row exclusive mode;

alter table public.players add column if not exists previous_names text[] not null default '{}';
create unique index if not exists players_name_case_insensitive on public.players (lower(name));

-- Keep old profile names as import aliases, separately from Battle.net accounts.
create or replace function public.prepare_player_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.name := pg_catalog.btrim(new.name);
  if new.name is null or new.name = '' or pg_catalog.lower(new.name) = 'me' then
    raise exception 'Please choose a non-empty nickname other than me.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.players p
    where (tg_op = 'INSERT' or p.name is distinct from old.name)
      and (pg_catalog.lower(p.name) = pg_catalog.lower(new.name)
        or exists (select 1 from pg_catalog.unnest(p.previous_names) alias
          where pg_catalog.lower(alias) = pg_catalog.lower(new.name))
        or exists (select 1 from pg_catalog.jsonb_array_elements_text(
          coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) account
          where pg_catalog.lower(account) = pg_catalog.lower(new.name)))
  ) then
    raise exception 'This name is already linked to another player.' using errcode = '23505';
  end if;
  if tg_op = 'UPDATE' and old.name is distinct from new.name then
    new.previous_names := old.previous_names;
    if not (old.name = any(new.previous_names)) then
      new.previous_names := pg_catalog.array_append(new.previous_names, old.name);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.prepare_player_name() from public, anon, authenticated;
drop trigger if exists prepare_player_name on public.players;
create trigger prepare_player_name before insert or update of name on public.players
for each row execute function public.prepare_player_name();

-- Also protect renames from older frontends that still update players directly.
create or replace function public.sync_player_history_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.player_matches set player_name = new.name where player_name = old.name;
  update public.player_history set player_name = new.name where player_name = old.name;
  update public.leaderboard_state set revision = revision + 1 where singleton;
  insert into public.audit_logs (action, admin_user, details) values (
    'RENAME_PLAYER', coalesce(auth.uid()::text, 'DATABASE'),
    pg_catalog.format('Renamed %s to %s; preserved matches and ELO history.', old.name, new.name)
  );
  return new;
end;
$$;
revoke all on function public.sync_player_history_name() from public, anon, authenticated;
drop trigger if exists sync_player_history_name on public.players;
create trigger sync_player_history_name after update of name on public.players
for each row when (old.name is distinct from new.name)
execute function public.sync_player_history_name();

create or replace function public.rename_player(p_current_name text, p_new_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target public.players%rowtype;
begin
  if actor is null then
    raise exception 'Please sign in to rename a profile.' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select * into target from public.players where name = p_current_name for update;
  if not found then
    raise exception 'This profile no longer exists under that name. Please reload.' using errcode = '40001';
  end if;
  if target.user_id is distinct from actor and not exists (
    select 1 from public.players where user_id = actor and is_admin is true
  ) then
    raise exception 'You may only rename your own profile.' using errcode = '42501';
  end if;
  update public.players set name = pg_catalog.btrim(p_new_name) where name = target.name returning * into target;
  return pg_catalog.jsonb_build_object('name', target.name, 'user_id', target.user_id);
end;
$$;
revoke all on function public.rename_player(text, text) from public, anon;
grant execute on function public.rename_player(text, text) to authenticated;

-- Invalidate imports calculated before the alias schema and rename protection.
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
