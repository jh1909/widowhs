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

select public._rerank_players_by_pb();
update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
