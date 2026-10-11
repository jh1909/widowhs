-- Deploy the updated upload-csv function before applying this migration.
-- Preserve matches/accounts and historical ELO, then record the new current ELO.
begin;

select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_history, public.player_matches in share row exclusive mode;

create or replace function pg_temp.rating_v2(kpm numeric, accuracy numeric, kdr numeric)
returns integer language sql immutable as $$
  select round((
    least(coalesce(kpm, 0) / 16.67, 1.67) * 0.65 +
    least(coalesce(accuracy, 0) / 60, 1.15) * 0.25 +
    least(coalesce(kdr, 0), 4.0) / 3.0 * 0.10
  ) * 1000)::integer
$$;

create or replace function pg_temp.rating_number(value text)
returns numeric language sql immutable as $$
  select case when trim(replace(value, '%', '')) ~ '^[0-9]+(\.[0-9]+)?$'
    then trim(replace(value, '%', ''))::numeric else 0 end
$$;

create temporary table rating_update on commit drop as
select p.name, scores.rating,
  row_number() over (order by scores.rating desc, lower(p.name) collate "C", p.name collate "C")::integer as rank,
  p.elo as old_elo, p.rank as old_rank
from public.players p
cross join lateral (
  select pg_temp.rating_v2(pg_temp.rating_number(p.kpm::text),
    pg_temp.rating_number(p.accuracy::text), pg_temp.rating_number(p.kdr::text)) as rating
) scores
where coalesce(p.matches, 0) > 0;

update public.player_matches set performance_score = pg_temp.rating_v2(kpm::numeric, accuracy::numeric, kdr::numeric) where true;

update public.players p set
  elo = pg_catalog.to_char(r.rating, 'FM9,999,999,990'), rank = r.rank,
  tag = case when r.rating >= 1200 then 'PRO' else '' end
from rating_update r where p.name = r.name;

update public.players set elo = '-', rank = 999999, tag = ''
where coalesce(matches, 0) = 0;

-- Historical entries keep their original scores; add a transition snapshot.
-- Re-running the script does not duplicate unchanged snapshots.
insert into public.player_history (player_name, elo, rank)
select name, rating, rank from rating_update
where old_elo is distinct from pg_catalog.to_char(rating, 'FM9,999,999,990')
  or old_rank is distinct from rank;

-- Reject imports computed from a snapshot taken before this recalculation.
update public.leaderboard_state set revision = revision + 1 where singleton;
insert into public.audit_logs (action, admin_user, details) values (
  'UPDATE_RATING_FORMULA', 'DATABASE_MIGRATION',
  'Recalculated current ELO, ranks and match scores: pace 65% (cap 1.67), accuracy 25% (cap 1.15), KDR 10% (cap 4.0).'
);

commit;
