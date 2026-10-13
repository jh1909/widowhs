-- Requires 20261013233000_weighted_elo_participation.sql.
-- Reduced weights affect ELO only; placement progress counts whole full matches.
begin;
select pg_catalog.pg_advisory_xact_lock(1909,1);
lock table public.players,public.player_matches,public.player_elo_legacy in share row exclusive mode;
alter table public.players add column if not exists placement_matches integer not null default 0;

create or replace function public.derive_player_placement_matches()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_name text;
begin
  -- A rename has not yet moved its raw logs or cascaded the legacy baseline.
  source_name := case when tg_op='UPDATE' then old.name else new.name end;
  select count(*)::integer + coalesce((select weight::integer from public.player_elo_legacy
    where player_name=source_name),0) into new.placement_matches
    from public.player_matches where player_name=source_name and elo_weight=1;
  return new;
end;
$$;
revoke all on function public.derive_player_placement_matches() from public,anon,authenticated,service_role;
drop trigger if exists derive_player_placement_matches on public.players;
-- Imports, corrections, transfers and resets already refresh elo. Reuse those
-- writes to derive placement counts, including older deployed Edge Functions.
create trigger derive_player_placement_matches before insert or update of name,elo,placement_matches on public.players
  for each row execute function public.derive_player_placement_matches();

update public.players set placement_matches=placement_matches where true;
update public.leaderboard_state set revision=revision+1 where singleton;
notify pgrst,'reload schema';
commit;
select 'Placements count fully eligible matches only; ELO weighting unchanged' as status;
