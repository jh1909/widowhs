-- Count unique players in global match history rather than session rows.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.player_matches in share row exclusive mode;

alter table public.player_matches add column if not exists round_winner text;

create or replace function public.get_global_matches(p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  with rounds as (
    select match_id, min(played_at) as played_at, count(distinct player_name) as player_count,
      max(total_match_time) as total_match_time, sum(score) as total_kills,
      coalesce(
        max(round_winner),
        (array_agg(coalesce(logged_player_name, player_name) order by score desc, coalesce(logged_player_name, player_name) collate "C")
          filter (where score >= 50))[1]
      ) as winner
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

notify pgrst, 'reload schema';
commit;
