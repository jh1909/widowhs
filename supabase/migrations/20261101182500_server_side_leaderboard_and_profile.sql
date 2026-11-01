-- Add server-side RPCs and covering indexes so Leaderboard and Profile pages
-- fetch only the current page / target standings instead of scanning the entire
-- players and player_matches tables into browser memory.
begin;

create index if not exists players_user_id_idx
  on public.players (user_id) where user_id is not null;
create index if not exists battlenet_oauth_requests_user_id_idx
  on public.battlenet_oauth_requests (user_id);
create index if not exists players_qualified_idx
  on public.players (name)
  where is_banned is not true
    and coalesce(placement_matches, matches, 0) >= 10
    and elo is not null and elo <> '-';
create index if not exists players_record_holder_idx
  on public.players (personal_best_time asc, lower(name) collate "C", name collate "C")
  where is_banned is not true
    and personal_best_time is not null
    and personal_best_time > 0;

create or replace function public.get_leaderboard_page(
  p_search text default '',
  p_limit integer default 10,
  p_offset integer default 0
)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  with ranked as (
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
      )::integer as rank
    from public.players p
    where p.is_banned is not true
      and coalesce(p.placement_matches, p.matches, 0) >= 10
      and p.elo is not null
      and pg_catalog.replace(p.elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
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
    'ranked_players', (select count(*)::integer from ranked),
    'filtered_count', (select count(*)::integer from filtered),
    'total_kills', (select coalesce(sum(score), 0)::bigint from ranked),
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

revoke all on function public.get_leaderboard_page(text, integer, integer) from public;
grant execute on function public.get_leaderboard_page(text, integer, integer) to anon, authenticated, service_role;

create or replace function public.get_player_qualified_standings(p_player_name text)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  with qualified as (
    select
      p.name,
      pg_catalog.row_number() over (
        order by
          pg_catalog.replace(p.elo::text, ',', '')::numeric desc,
          case when p.personal_best_time > 0 and p.personal_best_time::text not in ('NaN', 'Infinity', '-Infinity') then p.personal_best_time else null end asc nulls last,
          pg_catalog.lower(p.name) collate "C",
          p.name collate "C"
      )::integer as rank,
      case
        when p.recent_matches is not null then
          case when coalesce(p.recent_matches, 0) > 0 and p.recent_kdr >= 0 then round(p.recent_kdr::numeric, 2) else null end
        when p.kdr is not null and pg_catalog.btrim(p.kdr::text) ~ '^[0-9]+(\.[0-9]+)?$' then
          round(pg_catalog.btrim(p.kdr::text)::numeric, 2)
        else null
      end as kdr_val,
      case
        when p.recent_matches is not null then
          case when coalesce(p.recent_matches, 0) > 0 and p.recent_accuracy >= 0 then round(p.recent_accuracy::numeric, 2) else null end
        when p.accuracy is not null and pg_catalog.regexp_replace(pg_catalog.btrim(p.accuracy::text), '%$', '') ~ '^[0-9]+(\.[0-9]+)?$' then
          round(pg_catalog.regexp_replace(pg_catalog.btrim(p.accuracy::text), '%$', '')::numeric, 2)
        else null
      end as acc_val,
      case
        when p.recent_matches is not null then
          case when coalesce(p.recent_matches, 0) > 0 and p.recent_kpm >= 0 then round(p.recent_kpm::numeric, 2) else null end
        when p.kpm is not null and pg_catalog.btrim(p.kpm::text) ~ '^[0-9]+(\.[0-9]+)?$' then
          round(pg_catalog.btrim(p.kpm::text)::numeric, 2)
        else null
      end as pace_val,
      case
        when p.recent_matches is not null then
          case when coalesce(p.recent_matches, 0) > 0 and p.recent_crouches >= 0 and p.recent_time_in_lobby > 0 then
            round((p.recent_crouches::numeric / (p.recent_time_in_lobby::numeric / 60.0)), 1)
          else null end
        when p.crouches >= 0 and p.time_in_lobby > 0 then
          round((p.crouches::numeric / (p.time_in_lobby::numeric / 60.0)), 1)
        else null
      end as crouches_val
    from public.players p
    where p.is_banned is not true
      and coalesce(p.placement_matches, p.matches, 0) >= 10
      and p.elo is not null
      and pg_catalog.replace(p.elo::text, ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  target as (
    select * from qualified where name = p_player_name
  ),
  kdr_leaders as (
    select kdr_val, pg_catalog.row_number() over (order by kdr_val desc)::integer as pos
    from (select distinct kdr_val from qualified where kdr_val > 0) d
  ),
  acc_leaders as (
    select acc_val, pg_catalog.row_number() over (order by acc_val desc)::integer as pos
    from (select distinct acc_val from qualified where acc_val > 0) d
  ),
  pace_leaders as (
    select pace_val, pg_catalog.row_number() over (order by pace_val desc)::integer as pos
    from (select distinct pace_val from qualified where pace_val > 0) d
  ),
  crouch_leaders as (
    select crouches_val, pg_catalog.row_number() over (order by crouches_val desc)::integer as pos
    from (select distinct crouches_val from qualified where crouches_val > 0) d
  )
  select pg_catalog.jsonb_build_object(
    'rank', (select rank from target),
    'medals', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kdr', (select (array['gold','silver','bronze'])[pos] from kdr_leaders l join target t on t.kdr_val = l.kdr_val where l.pos <= 3),
      'accuracy', (select (array['gold','silver','bronze'])[pos] from acc_leaders l join target t on t.acc_val = l.acc_val where l.pos <= 3),
      'pace', (select (array['gold','silver','bronze'])[pos] from pace_leaders l join target t on t.pace_val = l.pace_val where l.pos <= 3),
      'crouches', (select (array['gold','silver','bronze'])[pos] from crouch_leaders l join target t on t.crouches_val = l.crouches_val where l.pos <= 3)
    ))
  );
$$;

revoke all on function public.get_player_qualified_standings(text) from public;
grant execute on function public.get_player_qualified_standings(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
