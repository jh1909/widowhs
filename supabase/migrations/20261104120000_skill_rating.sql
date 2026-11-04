-- Brief 01: skill rating (SR), computed in the database and hidden from the
-- site. Adds rating_params, player_ratings, rating_events and round_ratings,
-- the SQL that assembles stored rounds into the engine's input, a replay that
-- re-rates history from the first affected round, and the hooks that run it
-- whenever history changes (docs/briefs/01-skill-rating.md, docs/schema.md).
--
-- Deploy after 20261103120000_log_ingest.sql (it reads raw_logs and
-- player_sessions). Nothing else needs deploying with it, and it changes
-- nothing visible on the site: the new tables have RLS on and no grants to
-- anon or authenticated until the SR UI ships. Applying it rates the whole
-- history once, under the import lock.
--
-- How it fits together:
-- * Every history change (rows of player_matches inserted, updated or deleted;
--   a ban or unban; a profile created or deleted over existing rows; the
--   active rating_params changing) queues the earliest affected round time in
--   rating_replay_queue. A deferred trigger drains the queue once, at commit,
--   and replays from there, in the same transaction as the change. Imports
--   write their sessions after their rows, so replaying at commit sees whole
--   rounds; a failed change rolls the ratings back with it.
-- * Renames and merges into a profile with no rounds of its own only move
--   names: their ratings are relabelled instead of replayed, which gives the
--   same result because participants are ordered by row id, not by name.
-- * public._sr_rate_round is the per-round rating step.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

-- Parameters are data: every rating names the version it was computed with,
-- and changing the active version replays everything.
create table public.rating_params (
  version integer primary key check (version > 0),
  d double precision not null check (d > 0),
  beta double precision not null check (beta >= 0 and beta < 1),
  settings jsonb not null default '{}' check (pg_catalog.jsonb_typeof(settings) = 'object'),
  active boolean not null default false,
  note text,
  created_at timestamptz not null default pg_catalog.now()
);
create unique index rating_params_one_active on public.rating_params (active) where active;

-- Current SR per player: the state after their last rated round, plus the
-- standings. Banned players and players without a rated round have no row.
create table public.player_ratings (
  player_name text primary key references public.players(name) on update cascade on delete cascade,
  sr double precision not null,
  uncertainty double precision not null,
  cautious_sr double precision not null,
  placed boolean not null,
  rank integer,
  rated_weight double precision not null,
  rated_rounds integer not null,
  last_rated_at timestamptz not null
);
create index player_ratings_rank_idx on public.player_ratings (rank) where rank is not null;

-- One row per player per rated round. played_at is the round's time; the
-- *_after columns and the running totals are the player's whole state after
-- the round, so a replay can resume from any round.
create table public.rating_events (
  match_id uuid not null,
  player_name text not null references public.players(name) on update cascade on delete cascade,
  played_at timestamptz not null,
  params_version integer not null references public.rating_params(version),
  weight double precision not null,
  sr_before double precision not null,
  sr_after double precision not null,
  uncertainty_before double precision not null,
  uncertainty_after double precision not null,
  expected_share double precision,
  actual_share double precision,
  performance double precision,
  rated_weight double precision not null,
  rated_rounds integer not null,
  primary key (match_id, player_name)
);
create index rating_events_round_order_idx on public.rating_events (played_at, match_id);
create index rating_events_player_idx on public.rating_events (player_name, played_at desc);

-- Lobby strength per round given to the rating step.
create table public.round_ratings (
  match_id uuid primary key,
  played_at timestamptz not null,
  params_version integer not null references public.rating_params(version),
  lobby_sr_mean double precision,
  lobby_sr_min double precision,
  lobby_sr_max double precision,
  rated_players integer not null
);
create index round_ratings_played_at_idx on public.round_ratings (played_at);

-- Replays requested by the current transaction; always empty once committed.
-- from_at 'infinity' asks only for the standings to be refreshed.
create table public.rating_replay_queue (
  id bigint generated always as identity primary key,
  from_at timestamptz not null
);

alter table public.rating_params enable row level security;
alter table public.player_ratings enable row level security;
alter table public.rating_events enable row level security;
alter table public.round_ratings enable row level security;
alter table public.rating_replay_queue enable row level security;
revoke all on public.rating_params, public.player_ratings, public.rating_events, public.round_ratings,
  public.rating_replay_queue from public, anon, authenticated;
grant select on public.rating_params, public.player_ratings, public.rating_events, public.round_ratings to service_role;

-- PLACEHOLDER values: the backtest sets the real version.
insert into public.rating_params (version, d, beta, settings, active, note) values (1, 400, 0.1,
  '{"placeholder": true, "start_sr": 1500, "start_uncertainty": 350, "min_uncertainty": 50,
    "placed_uncertainty": 210, "min_present_s": 30, "standin_k": 32}', true,
  'PLACEHOLDER until the backtest chooses the settings');

-- Input assembly: stored rounds from p_from on, in rating order (round time,
-- then match_id as text), each in the engine's input shape:
--   {id, playedAt, length, winner, participants: [{name, kills, present, afk,
--    shots, intervals: [[start, end], ...]}]}
-- * A round's time is the earliest played_at of its rows.
-- * One participant per profile: rows of one profile in a round are merged
--   (kills summed). v1: time present is the longest row's time in lobby; v2:
--   the union of the profile's sessions. Participants are ordered by their
--   first row id, which renames don't change.
-- * Rows of banned players and rows without a profile are left out.
-- * v1: round length is the total match time (else the longest time in
--   lobby), time present is capped at it, and the interval is [L - present, L].
--   A v1 round whose rows disagree on the match time is several files that an
--   old importer gave one round id, and is not rated.
-- * v2: round length and winner come from the raw log; sessions are clipped
--   to [0, L]; overlapping sessions of one profile count once.
-- * Winner: v2, the profile whose session carries the logged winner's name;
--   v1, the sole top scorer with at least 50 kills; otherwise null.
create function public._sr_round_inputs(p_from timestamptz default '-infinity')
returns table (match_id uuid, played_at timestamptz, round jsonb)
language sql stable security definer set search_path = '' as $$
  with rounds as (
    select m.match_id, min(m.played_at) as played_at,
      count(distinct m.total_match_time) as match_times,
      max(m.total_match_time)::double precision as total,
      max(m.time_in_lobby)::double precision as longest
    from public.player_matches m
    where m.match_id in (select f.match_id from public.player_matches f
      where f.played_at >= coalesce(p_from, '-infinity'::timestamptz))
    group by m.match_id
    having min(m.played_at) >= coalesce(p_from, '-infinity'::timestamptz)
  ),
  shaped as (
    select r.match_id, r.played_at, coalesce(l.format_version = 2, false) as v2,
      case when l.format_version = 2 then coalesce(l.round_length::double precision, r.total)
        else coalesce(r.total, r.longest) end as length,
      case when l.format_version = 2 then nullif(pg_catalog.btrim(l.winner_name), '') end as winner_name
    from rounds r left join public.raw_logs l on l.match_id = r.match_id
    where coalesce(l.format_version = 2, false) or r.match_times <= 1
  ),
  rows as (
    select s.match_id, m.id, m.player_name, m.score, m.time_in_lobby::double precision as time_in_lobby,
      m.afk_seconds, m.shots
    from shaped s
    join public.player_matches m on m.match_id = s.match_id
    join public.players p on p.name = m.player_name
    where p.is_banned is not true and s.length > 0
  ),
  sessions as (
    select r.match_id, r.player_name, greatest(ps.start_s, 0) as a,
      least(ps.end_s, s.length::numeric) as b
    from rows r join shaped s on s.match_id = r.match_id
    join public.player_sessions ps on ps.participation_id = r.id
    where s.v2
  ),
  starts as (
    select x.*, case when x.a <= max(x.b) over (partition by x.match_id, x.player_name order by x.a, x.b
      rows between unbounded preceding and 1 preceding) then 0 else 1 end as starts_island
    from sessions x
  ),
  islands as (
    select x.*, sum(x.starts_island) over (partition by x.match_id, x.player_name order by x.a, x.b
      rows unbounded preceding) as island
    from starts x
  ),
  spans as (
    select x.match_id, x.player_name, min(x.a) as a, greatest(min(x.a), max(x.b)) as b
    from islands x group by x.match_id, x.player_name, x.island
  ),
  presence as (
    select x.match_id, x.player_name, sum(x.b - x.a)::double precision as present,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(x.a::double precision, x.b::double precision) order by x.a) as intervals
    from spans x group by x.match_id, x.player_name
  ),
  people as (
    select r.match_id, r.player_name, min(r.id) as first_id, sum(r.score)::integer as kills,
      max(r.time_in_lobby) as longest, coalesce(sum(r.afk_seconds), 0)::double precision as afk,
      sum(r.shots)::integer as shots
    from rows r group by r.match_id, r.player_name
  ),
  participants as (
    select e.match_id, e.player_name, e.first_id, e.kills,
      case when s.v2 and v.present is not null then v.present else least(e.longest, s.length) end as present,
      case when s.v2 then e.afk else 0 end as afk,
      case when s.v2 then e.shots end as shots,
      case when s.v2 and v.intervals is not null then v.intervals
        else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(s.length - least(e.longest, s.length), s.length)) end
        as intervals
    from people e join shaped s on s.match_id = e.match_id
    left join presence v on v.match_id = e.match_id and v.player_name = e.player_name
  ),
  v2_winners as (
    select r.match_id, min(r.player_name) as player_name
    from rows r join shaped s on s.match_id = r.match_id
    join public.player_sessions ps on ps.participation_id = r.id
    where s.v2 and pg_catalog.lower(ps.logged_name) = pg_catalog.lower(s.winner_name)
    group by r.match_id having count(distinct r.player_name) = 1
  ),
  v1_tops as (
    select p.match_id, max(p.kills) as kills from participants p
    join shaped s on s.match_id = p.match_id where not s.v2 group by p.match_id
  ),
  v1_winners as (
    select p.match_id, min(p.player_name) as player_name
    from participants p join v1_tops t on t.match_id = p.match_id and t.kills = p.kills
    where t.kills >= 50 group by p.match_id having count(*) = 1
  )
  select s.match_id, s.played_at, pg_catalog.jsonb_build_object(
    'id', s.match_id,
    'playedAt', pg_catalog.to_char(s.played_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'length', s.length,
    'winner', coalesce(w2.player_name, w1.player_name),
    'participants', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', p.player_name, 'kills', p.kills, 'present', p.present, 'afk', p.afk,
      'shots', p.shots, 'intervals', p.intervals) order by p.first_id))
  from shaped s
  join participants p on p.match_id = s.match_id
  left join v2_winners w2 on w2.match_id = s.match_id
  left join v1_winners w1 on w1.match_id = s.match_id
  group by s.match_id, s.played_at, s.length, w2.player_name, w1.player_name
  order by s.played_at, s.match_id::text collate "C";
$$;

-- A new player's state before their first round.
create function public._sr_start_state(p_params public.rating_params)
returns jsonb language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'sr', coalesce((p_params.settings ->> 'start_sr')::double precision, 1500),
    'uncertainty', coalesce((p_params.settings ->> 'start_uncertainty')::double precision, 350),
    'ratedWeight', 0::double precision, 'ratedRounds', 0, 'lastRatedAt', null);
$$;

-- The per-round rating step. Takes the active parameters, one round from
-- _sr_round_inputs and every participant's state before the round
-- ({name: {sr, uncertainty, ratedWeight, ratedRounds, lastRatedAt}}), and
-- returns {lobby: {mean, min, max} | null, players: [{name, weight, srBefore,
-- srAfter, uncertaintyBefore, uncertaintyAfter, expectedShare, actualShare,
-- performance}]} for the players it rated.
--
-- STAND-IN until the engine (supabase/functions/_shared/sr.ts) is ported:
-- players present at least min_present_s (less AFK time) are rated when there
-- are two or more; weight is active time over round length; expected share is
-- a softmax of ratings; SR moves by standin_k x weight x (actual - expected)
-- and uncertainty shrinks by 5% a round. Not the SR formula.
create function public._sr_rate_round(p_params public.rating_params, p_round jsonb, p_states jsonb)
returns jsonb language sql stable set search_path = '' as $$
  with parts as (
    select e.ord, e.v ->> 'name' as name, (e.v ->> 'kills')::double precision as kills,
      greatest((e.v ->> 'present')::double precision - (e.v ->> 'afk')::double precision, 0) as active,
      (p_states -> (e.v ->> 'name') ->> 'sr')::double precision as sr,
      (p_states -> (e.v ->> 'name') ->> 'uncertainty')::double precision as uncertainty
    from pg_catalog.jsonb_array_elements(p_round -> 'participants') with ordinality as e(v, ord)
  ),
  rated as (
    select * from parts where active >= coalesce((p_params.settings ->> 'min_present_s')::double precision, 30)
  ),
  totals as (
    select count(*) as n, sum(kills) as kills, sum(pg_catalog.power(10::double precision, sr / p_params.d)) as z from rated
  ),
  shares as (
    select r.*, least(1, r.active / (p_round ->> 'length')::double precision) as weight,
      case when t.kills > 0 then r.kills / t.kills else 1.0::double precision / t.n end as actual,
      pg_catalog.power(10::double precision, r.sr / p_params.d) / t.z as expected
    from rated r cross join totals t where t.n >= 2
  )
  select pg_catalog.jsonb_build_object(
    'lobby', case when count(*) > 0 then pg_catalog.jsonb_build_object(
      'mean', sum(weight * sr) / sum(weight), 'min', min(sr), 'max', max(sr)) end,
    'players', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', name, 'weight', weight, 'srBefore', sr,
      'srAfter', sr + coalesce((p_params.settings ->> 'standin_k')::double precision, 32) * weight * (actual - expected),
      'uncertaintyBefore', uncertainty,
      'uncertaintyAfter', greatest(coalesce((p_params.settings ->> 'min_uncertainty')::double precision, 50), uncertainty * 0.95),
      'expectedShare', expected, 'actualShare', actual, 'performance', actual - expected) order by ord), '[]'))
  from shares;
$$;

-- Ranks placed, non-banned players by cautious SR (then name, as the
-- leaderboard does).
create function public._sr_refresh_standings()
returns void language sql security definer set search_path = '' as $$
  with standings as (
    select r.player_name, case when r.placed and p.is_banned is not true then pg_catalog.row_number() over (
      partition by r.placed and p.is_banned is not true
      order by r.cautious_sr desc, pg_catalog.lower(r.player_name) collate "C", r.player_name collate "C") end::integer as rank
    from public.player_ratings r join public.players p on p.name = r.player_name
  )
  update public.player_ratings r set rank = s.rank from standings s
  where s.player_name = r.player_name and r.rank is distinct from s.rank;
$$;

-- Re-rates every round from p_from on: deletes their ratings, restores each
-- affected player's state from their last earlier event (or none, so they
-- start fresh), rates the rounds in order and refreshes the standings.
-- Returns the number of rounds rated; a no-op when nothing is at or after p_from.
create function public.replay_ratings(p_from timestamptz default '-infinity')
returns integer language plpgsql security definer set search_path = '' as $$
declare
  params public.rating_params%rowtype;
  start_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  start_state jsonb;
  placed_below double precision;
  item record;
  states jsonb;
  result jsonb;
  touched text[];
  rated integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  select * into params from public.rating_params where active;
  if not found then
    delete from public.rating_events where true;
    delete from public.round_ratings where true;
    delete from public.player_ratings where true;
    return 0;
  end if;
  if not exists (select 1 from public.rating_events where played_at >= start_from)
    and not exists (select 1 from public.round_ratings where played_at >= start_from)
    and not exists (select 1 from public.player_matches where played_at >= start_from) then
    return 0;
  end if;

  with removed as (delete from public.rating_events where played_at >= start_from returning player_name)
    select pg_catalog.array_agg(distinct player_name) into touched from removed;
  delete from public.round_ratings where played_at >= start_from;
  if touched is not null then
    delete from public.player_ratings where player_name = any(touched);
    insert into public.player_ratings (player_name, sr, uncertainty, cautious_sr, placed, rank,
      rated_weight, rated_rounds, last_rated_at)
    select distinct on (e.player_name) e.player_name, e.sr_after, e.uncertainty_after,
      e.sr_after - 2 * e.uncertainty_after,
      e.uncertainty_after <= (params.settings ->> 'placed_uncertainty')::double precision, null,
      e.rated_weight, e.rated_rounds, e.played_at
    from public.rating_events e where e.player_name = any(touched)
    order by e.player_name, e.played_at desc, e.match_id::text collate "C" desc;
  end if;

  start_state := public._sr_start_state(params);
  placed_below := (params.settings ->> 'placed_uncertainty')::double precision;
  for item in select i.match_id, i.played_at, i.round from public._sr_round_inputs(start_from) i
    order by i.played_at, i.match_id::text collate "C"
  loop
    select pg_catalog.jsonb_object_agg(p.name, coalesce(case when r.player_name is not null then
        pg_catalog.jsonb_build_object('sr', r.sr, 'uncertainty', r.uncertainty, 'ratedWeight', r.rated_weight,
          'ratedRounds', r.rated_rounds, 'lastRatedAt', r.last_rated_at) end, start_state))
      into states
    from pg_catalog.jsonb_to_recordset(item.round -> 'participants') as p(name text)
    left join public.player_ratings r on r.player_name = p.name;
    result := public._sr_rate_round(params, item.round, states);

    with events as (
      insert into public.rating_events (match_id, player_name, played_at, params_version, weight,
        sr_before, sr_after, uncertainty_before, uncertainty_after, expected_share, actual_share, performance,
        rated_weight, rated_rounds)
      select item.match_id, x.name, item.played_at, params.version, x.weight,
        x."srBefore", x."srAfter", x."uncertaintyBefore", x."uncertaintyAfter",
        x."expectedShare", x."actualShare", x.performance,
        coalesce(r.rated_weight, 0) + x.weight, coalesce(r.rated_rounds, 0) + 1
      from pg_catalog.jsonb_to_recordset(result -> 'players') as x(name text, weight double precision,
        "srBefore" double precision, "srAfter" double precision, "uncertaintyBefore" double precision,
        "uncertaintyAfter" double precision, "expectedShare" double precision, "actualShare" double precision,
        performance double precision)
      left join public.player_ratings r on r.player_name = x.name
      returning *
    )
    insert into public.player_ratings as r (player_name, sr, uncertainty, cautious_sr, placed, rank,
      rated_weight, rated_rounds, last_rated_at)
    select e.player_name, e.sr_after, e.uncertainty_after, e.sr_after - 2 * e.uncertainty_after,
      e.uncertainty_after <= placed_below, null, e.rated_weight, e.rated_rounds, e.played_at
    from events e
    on conflict (player_name) do update set sr = excluded.sr, uncertainty = excluded.uncertainty,
      cautious_sr = excluded.cautious_sr, placed = excluded.placed, rated_weight = excluded.rated_weight,
      rated_rounds = excluded.rated_rounds, last_rated_at = excluded.last_rated_at;

    insert into public.round_ratings (match_id, played_at, params_version, lobby_sr_mean, lobby_sr_min,
      lobby_sr_max, rated_players)
    values (item.match_id, item.played_at, params.version, (result -> 'lobby' ->> 'mean')::double precision,
      (result -> 'lobby' ->> 'min')::double precision, (result -> 'lobby' ->> 'max')::double precision,
      pg_catalog.jsonb_array_length(result -> 'players'));
    rated := rated + 1;
  end loop;
  perform public._sr_refresh_standings();
  return rated;
end;
$$;

-- Hooks. Each records the earliest round time it affects; one deferred
-- trigger replays from the earliest of them when the transaction commits.
create function public._sr_request_replay(p_from timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into public.rating_replay_queue (from_at) select p_from where p_from is not null;
$$;

-- The earliest round time among rounds that contain any of these profiles' rows.
create function public._sr_first_round_of(p_names text[])
returns timestamptz language sql stable security definer set search_path = '' as $$
  select min(o.played_at) from public.player_matches m
  join public.player_matches o on o.match_id = m.match_id
  where m.player_name = any(p_names);
$$;

create function public._sr_run_queued_replay()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  first_from timestamptz;
  queued bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  with drained as (delete from public.rating_replay_queue where true returning from_at)
    select min(from_at), count(*) into first_from, queued from drained;
  if queued = 0 then return null; end if;
  if first_from = 'infinity'::timestamptz then
    perform public._sr_refresh_standings();
  else
    perform public.replay_ratings(first_from);
  end if;
  return null;
end;
$$;
create constraint trigger sr_run_queued_replay after insert on public.rating_replay_queue
  deferrable initially deferred for each row execute function public._sr_run_queued_replay();

-- player_matches: any change to a round's rated inputs replays from that
-- round (its earliest time before or after the change). A change that only
-- moves every row of profiles to profiles with no rows of their own and the
-- same ban status (a rename, or a merge into an empty profile) relabels the
-- ratings instead. Statement-level, so an import of many rows queues once.
create function public._sr_matches_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ids uuid[];
  first_old timestamptz;
  relabel boolean := false;
begin
  if tg_op = 'INSERT' then
    select pg_catalog.array_agg(distinct match_id) into ids from new_rows;
  elsif tg_op = 'DELETE' then
    select pg_catalog.array_agg(distinct match_id), min(played_at) into ids, first_old from old_rows;
  else
    with changed as (
      select o.player_name as old_name, n.player_name as new_name, o.match_id as old_match,
        n.match_id as new_match, o.played_at as old_at,
        (o.match_id, o.played_at, o.score, o.time_in_lobby, o.total_match_time, o.status, o.afk_seconds, o.shots)
          is not distinct from
        (n.match_id, n.played_at, n.score, n.time_in_lobby, n.total_match_time, n.status, n.afk_seconds, n.shots)
          as same_input
      from old_rows o full join new_rows n on n.id = o.id
      where o.id is null or n.id is null
        or (o.player_name, o.match_id, o.played_at, o.score, o.time_in_lobby, o.total_match_time, o.status,
          o.afk_seconds, o.shots) is distinct from
        (n.player_name, n.match_id, n.played_at, n.score, n.time_in_lobby, n.total_match_time, n.status,
          n.afk_seconds, n.shots)
    ),
    pairs as (select distinct old_name, new_name from changed)
    select
      (select pg_catalog.array_agg(distinct x.m) from changed c
        cross join lateral (values (c.old_match), (c.new_match)) x(m) where x.m is not null),
      (select min(old_at) from changed),
      coalesce((select bool_and(c.same_input and c.old_name <> c.new_name) from changed c), false)
      and (select count(distinct old_name) = count(*) and count(distinct new_name) = count(*) from pairs)
      and not exists (select 1 from pairs a join pairs b on a.old_name = b.new_name)
      -- every row of the old names moved
      and not exists (select 1 from public.player_matches m where m.player_name in (select old_name from pairs))
      -- the new names had no rows of their own
      and not exists (select 1 from pairs x
        where (select count(*) from public.player_matches m where m.player_name = x.new_name)
          <> (select count(*) from changed c where c.new_name = x.new_name))
      -- same eligibility: the new profile exists, and either the old one has the
      -- same ban status or it is gone because it was renamed to the new one
      and not exists (select 1 from pairs x
        left join public.players n on n.name = x.new_name
        left join public.players o on o.name = x.old_name
        where n.name is null
          or (o.name is not null and (o.is_banned is true) <> (n.is_banned is true))
          or (o.name is null and not (x.old_name = any(n.previous_names))))
      into ids, first_old, relabel;
    if ids is null then return null; end if;
    if relabel then
      update public.rating_events e set player_name = n.player_name
        from old_rows o join new_rows n on n.id = o.id
        where e.player_name = o.player_name and n.player_name <> o.player_name;
      update public.player_ratings r set player_name = n.player_name
        from old_rows o join new_rows n on n.id = o.id
        where r.player_name = o.player_name and n.player_name <> o.player_name;
      perform public._sr_request_replay('infinity');
      return null;
    end if;
  end if;
  if ids is not null then
    perform public._sr_request_replay(least(first_old,
      (select min(m.played_at) from public.player_matches m where m.match_id = any(ids))));
  end if;
  return null;
end;
$$;
create trigger sr_matches_inserted after insert on public.player_matches
  referencing new table as new_rows for each statement execute function public._sr_matches_changed();
create trigger sr_matches_updated after update on public.player_matches
  referencing old table as old_rows new table as new_rows for each statement execute function public._sr_matches_changed();
create trigger sr_matches_deleted after delete on public.player_matches
  referencing old table as old_rows for each statement execute function public._sr_matches_changed();

-- players: a ban or unban replays from the player's first round. A profile
-- created or deleted over rows that carry its name (rows without a profile
-- are not rated) replays from their first round.
create function public._sr_player_ban_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._sr_request_replay(public._sr_first_round_of(array[old.name, new.name]));
  return null;
end;
$$;
create trigger sr_player_ban_changed after update of is_banned on public.players
  for each row when (old.is_banned is distinct from new.is_banned) execute function public._sr_player_ban_changed();

create function public._sr_players_added_or_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare names text[];
begin
  if tg_op = 'INSERT' then
    select pg_catalog.array_agg(n.name) into names from new_players n
      where exists (select 1 from public.player_matches m where m.player_name = n.name);
  else
    select pg_catalog.array_agg(o.name) into names from old_players o
      where exists (select 1 from public.player_matches m where m.player_name = o.name);
  end if;
  if names is not null then perform public._sr_request_replay(public._sr_first_round_of(names)); end if;
  return null;
end;
$$;
create trigger sr_players_added after insert on public.players
  referencing new table as new_players for each statement execute function public._sr_players_added_or_removed();
create trigger sr_players_removed after delete on public.players
  referencing old table as old_players for each statement execute function public._sr_players_added_or_removed();

-- rating_params: activating, changing or deactivating the active version
-- replays everything.
create function public._sr_params_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._sr_request_replay('-infinity');
  return null;
end;
$$;
create trigger sr_params_inserted after insert on public.rating_params
  for each row when (new.active) execute function public._sr_params_changed();
create trigger sr_params_updated after update on public.rating_params
  for each row when ((old.active or new.active) and old.* is distinct from new.*) execute function public._sr_params_changed();
create trigger sr_params_deleted after delete on public.rating_params
  for each row when (old.active) execute function public._sr_params_changed();

revoke all on function public._sr_round_inputs(timestamptz), public._sr_start_state(public.rating_params),
  public._sr_rate_round(public.rating_params, jsonb, jsonb), public._sr_refresh_standings(),
  public.replay_ratings(timestamptz), public._sr_request_replay(timestamptz), public._sr_first_round_of(text[]),
  public._sr_run_queued_replay(), public._sr_matches_changed(), public._sr_player_ban_changed(),
  public._sr_players_added_or_removed(), public._sr_params_changed()
  from public, anon, authenticated, service_role;
grant execute on function public.replay_ratings(timestamptz) to service_role;

-- Rate the whole history once.
select public.replay_ratings();

notify pgrst, 'reload schema';
commit;
