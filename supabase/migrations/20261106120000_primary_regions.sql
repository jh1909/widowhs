-- Optional primary region follows the login, like bio/setup, through renames
-- and Battle.net merges. Imported/unset players appear only in All regions.
-- Apply on staging, then production, before deploying the region UI. No SR,
-- importer or Workshop deployment is needed. Existing three-argument RPCs
-- remain compatible: old profile saves preserve region, old leaderboards are global.
begin;

alter table public.player_profile_details
  add column primary_region text check (primary_region in ('eu', 'na'));

create or replace function public.get_player_profile_details(p_player_name text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('bio', coalesce(d.bio, ''), 'setup', coalesce(d.setup, '{}'::jsonb),
    'primary_region', d.primary_region)
  from public.players p left join public.player_profile_details d on d.user_id = p.user_id
  where p.name = p_player_name;
$$;

-- The existing save performs ownership/admin checks, locks the player row,
-- validates bio/setup and audits moderation. Keeping its overload also means
-- an older browser saving bio/setup cannot erase a newly selected region.
create function public.update_player_profile_details(
  p_player_name text, p_bio text, p_setup jsonb, p_primary_region text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target_owner uuid; prior_region text;
begin
  perform public.update_player_profile_details(p_player_name, p_bio, p_setup);
  if p_primary_region is not null and p_primary_region not in ('eu', 'na') then
    raise exception 'Primary region must be EU, NA or unset.' using errcode = '22023';
  end if;
  select user_id into target_owner from public.players where name = p_player_name;
  select primary_region into prior_region from public.player_profile_details
    where user_id = target_owner for update;
  update public.player_profile_details set primary_region = p_primary_region where user_id = target_owner;
  if target_owner is distinct from auth.uid() and prior_region is distinct from p_primary_region then
    insert into public.audit_logs(action, admin_user, details) values (
      'MODERATE_PRIMARY_REGION', auth.uid()::text, format('Updated primary region on %s.', p_player_name));
  end if;
  return public.get_player_profile_details(p_player_name);
end;
$$;
revoke all on function public.update_player_profile_details(text,text,jsonb,text) from public, anon;
grant execute on function public.update_player_profile_details(text,text,jsonb,text) to authenticated;

-- Rank the selected population before searching/paging. Preserve global_rank
-- for podium decoration; summary metrics and the record holder stay global.
create or replace function public.get_leaderboard_page(
  p_search text,
  p_limit integer,
  p_offset integer,
  p_region text
)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  with global_ranked as (
    select
      p.name, p.elo, p.tag, p.matches, p.score, p.kdr, p.kpm, p.accuracy,
      p.crouches, p.time_in_lobby, p.avatar_url, p.is_verified, p.is_banned,
      p.bnet_accounts, p.personal_best_time, p.placement_matches,
      p.recent_matches, p.recent_kdr, p.recent_accuracy, p.recent_kpm,
      p.recent_crouches, p.recent_time_in_lobby,
      pg_catalog.row_number() over (
        order by
          pg_catalog.replace(p.elo::text, ',', '')::numeric desc,
          case when p.personal_best_time > 0 and p.personal_best_time::text not in ('NaN', 'Infinity', '-Infinity') then p.personal_best_time else null end asc nulls last,
          pg_catalog.lower(p.name) collate "C",
          p.name collate "C"
      )::integer as global_rank, d.primary_region
    from public.players p
    left join public.player_profile_details d on d.user_id = p.user_id
    where p.is_banned is not true
      and coalesce(p.placement_matches, p.matches, 0) >= 10
      and p.elo is not null
      and pg_catalog.replace(p.elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  ranked as (
    select g.*, pg_catalog.row_number() over (order by global_rank)::integer as rank
    from global_ranked g
    where p_region is null or g.primary_region = p_region
  ),
  filtered as (
    select *
    from ranked r
    where coalesce(pg_catalog.btrim(p_search), '') = ''
      or pg_catalog.strpos(pg_catalog.lower(r.name), pg_catalog.lower(pg_catalog.btrim(p_search))) > 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(r.bnet_accounts), '[]'::jsonb)) acc
        where pg_catalog.strpos(pg_catalog.lower(acc), pg_catalog.lower(pg_catalog.btrim(p_search))) > 0
      )
  ),
  page as (
    select *
    from filtered
    order by rank asc
    limit least(greatest(coalesce(p_limit, 10), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select pg_catalog.jsonb_build_object(
    'ranked_players', (select count(*)::integer from global_ranked),
    'filtered_count', (select count(*)::integer from filtered),
    'total_kills', (select coalesce(sum(score), 0)::bigint from global_ranked),
    'total_matches', (select count(distinct match_id)::bigint from public.player_matches),
    'record_holder', (
      select pg_catalog.jsonb_build_object(
        'name', p.name,
        'is_verified', p.is_verified,
        'personal_best_time', p.personal_best_time
      )
      from public.players p
      where p.is_banned is not true
        and p.personal_best_time is not null
        and p.personal_best_time > 0
        and p.personal_best_time::text not in ('NaN', 'Infinity', '-Infinity')
      order by p.personal_best_time asc, pg_catalog.lower(p.name) collate "C", p.name collate "C"
      limit 1
    ),
    'players', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page) order by rank asc) from page), '[]'::jsonb)
  );
$$;

revoke all on function public.get_leaderboard_page(text, integer, integer, text) from public;
grant execute on function public.get_leaderboard_page(text, integer, integer, text) to anon, authenticated, service_role;

-- Retain the old signature for deployed clients; regional calls supply all
-- four arguments, avoiding PostgREST overload/default ambiguity.
create or replace function public.get_leaderboard_page(
  p_search text default '', p_limit integer default 10, p_offset integer default 0
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.get_leaderboard_page(p_search, p_limit, p_offset, null);
$$;

notify pgrst, 'reload schema';
commit;
