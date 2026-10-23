-- Requires weighted ELO and fully eligible placement counts.
-- Keep lifetime aggregates for imports/merges; derive current performance from logs.
begin;
select pg_catalog.pg_advisory_xact_lock(1909,1);
lock table public.players,public.player_matches,public.player_history in share row exclusive mode;

alter table public.players add column if not exists recent_matches integer not null default 0;
alter table public.players add column if not exists recent_kdr numeric;
alter table public.players add column if not exists recent_accuracy numeric;
alter table public.players add column if not exists recent_kpm numeric;
alter table public.players add column if not exists recent_crouches numeric not null default 0;
alter table public.players add column if not exists recent_time_in_lobby numeric not null default 0;
alter table public.players add column if not exists speedrunner_count integer not null default 0;

create index if not exists player_matches_recent_eligible_idx
  on public.player_matches(player_name,played_at desc,created_at desc,id desc) where elo_weight>0;
create index if not exists player_matches_speedrunner_idx on public.player_matches(player_name)
  where score>=50 and total_match_time>0 and total_match_time<180;

create or replace function public.derive_player_weighted_elo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_name text; rating integer;
begin
  source_name := case when tg_op='UPDATE' then old.name else new.name end;
  select count(*)::integer,coalesce(sum(elo_weight),0),
    coalesce(sum(kpm*elo_weight),0),coalesce(sum(accuracy*elo_weight),0),coalesce(sum(kdr*elo_weight),0),
    coalesce(sum(crouches),0),coalesce(sum(time_in_lobby),0)
    into new.recent_matches,new.elo_weight_sum,new.elo_kpm_sum,new.elo_accuracy_sum,new.elo_kdr_sum,
      new.recent_crouches,new.recent_time_in_lobby
  from (select * from public.player_matches where player_name=source_name and elo_weight>0
    order by played_at desc,created_at desc,id desc limit 100) recent;

  select count(*)::integer into new.speedrunner_count from public.player_matches
    where player_name=source_name and score>=50 and total_match_time>0 and total_match_time<180;

  if new.elo_weight_sum>0 then
    new.recent_kdr := round(new.elo_kdr_sum/new.elo_weight_sum,2);
    new.recent_accuracy := round(new.elo_accuracy_sum/new.elo_weight_sum,2);
    new.recent_kpm := round(new.elo_kpm_sum/new.elo_weight_sum,2);
    rating := round((least(new.elo_kpm_sum/new.elo_weight_sum/16.67,1.67)*.65 +
      least(new.elo_accuracy_sum/new.elo_weight_sum/60,1.15)*.25 +
      least(new.elo_kdr_sum/new.elo_weight_sum,4)/3*.10)*1000);
    new.elo := pg_catalog.to_char(rating,'FM9,999,999,990');
    new.tag := case when rating>=1200 then 'PRO' else '' end;
  else
    new.recent_kdr := null; new.recent_accuracy := null; new.recent_kpm := null;
    new.elo := '-'; new.tag := ''; new.rank := 999999;
  end if;
  return new;
end;
$$;
revoke all on function public.derive_player_weighted_elo() from public,anon,authenticated,service_role;

drop trigger if exists derive_player_weighted_elo on public.players;
create trigger derive_player_weighted_elo before insert or update of name,elo,tag,
  elo_weight_sum,elo_kpm_sum,elo_accuracy_sum,elo_kdr_sum,recent_matches,recent_kdr,recent_accuracy,
  recent_kpm,recent_crouches,recent_time_in_lobby,speedrunner_count on public.players
  for each row execute function public.derive_player_weighted_elo();

-- Existing statement triggers refresh these caches after imports, corrections,
-- deletions and account transfers. PB and placement rules remain lifetime.
create temporary table recent_elo_before on commit drop as select name,elo from public.players;
update public.players set elo=elo where true;
select public._rerank_players_by_pb();
insert into public.player_history(player_name,elo,rank)
  select p.name,replace(p.elo::text,',','')::integer,p.rank from public.players p
  join recent_elo_before old on old.name=p.name
  where p.elo_weight_sum>0 and p.elo is distinct from old.elo;
update public.leaderboard_state set revision=revision+1 where singleton;
notify pgrst,'reload schema';
commit;
