begin;

create index if not exists player_history_recent_profile_idx
  on public.player_history(player_name, created_at desc, id desc);

-- Publish only the graph's existing public statistics, without opening the
-- history table API or changing its write policies.
create or replace function public.get_player_elo_history(p_player_name text)
returns table(elo integer, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select recent.elo, recent.created_at
  from (
    select h.id, h.elo, h.created_at
    from public.player_history h
    where h.player_name = p_player_name and h.elo is not null and h.created_at is not null
      and exists (select 1 from public.players p where p.name = h.player_name)
    order by h.created_at desc, h.id desc
    limit 30
  ) recent
  order by recent.created_at asc, recent.id asc;
$$;
revoke all on function public.get_player_elo_history(text) from public;
grant execute on function public.get_player_elo_history(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
