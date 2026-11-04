-- Brief 01: skill rating (SR), computed in the database and hidden from the
-- site. Adds rating_params, player_ratings, rating_events and round_ratings,
-- the SQL that assembles stored rounds into the engine's input, the rating
-- engine (a port of supabase/functions/_shared/sr.ts), a replay that re-rates
-- history from the first affected round, and the hooks that run it whenever
-- history changes (docs/briefs/01-skill-rating.md, docs/schema.md).
--
-- Deploy after 20261103120000_log_ingest.sql (it reads raw_logs and
-- player_sessions). Nothing else needs deploying with it, and it changes
-- nothing visible on the site: the new tables have RLS on and no grants to
-- anon or authenticated until the SR UI ships. Applying it rates the whole
-- history once, under the import lock.
--
-- It also fixes two existing problems:
-- * Rows whose player_name has no profile but matches, ignoring case, the
--   name, a previous name or a linked Battle.net name of exactly one profile
--   are moved to that profile (production: 22 rows from 11 October, imported
--   under Battle.net names before they were linked). logged_player_name is
--   kept. The profiles' lifetime counters already include these rows; the
--   existing player_matches triggers refresh recent stats, ELO, placements and
--   PB, and their daily ELO history is moved and recomputed here.
-- * Closes an existing hole: anon and authenticated could insert rows into
--   player_matches directly. Only the import (service role) writes it now.
--
-- How it fits together:
-- * Every history change (rows of player_matches inserted, updated or deleted;
--   corrections to player_sessions or raw_logs; a ban or unban; a profile
--   created, deleted or renamed over existing rows; the active rating_params
--   changing) queues the earliest affected round time in
--   rating_replay_queue. A deferred trigger drains the queue once, at commit,
--   and replays from there, in the same transaction as the change. Imports
--   write their sessions after their rows, so replaying at commit sees whole
--   rounds; a failed change rolls the ratings back with it.
-- * Renames and merges into a profile with no rounds of its own only move
--   names: their ratings are relabelled instead of replayed, which gives the
--   same result because participants are ordered by row id, not by name.
-- * public._sr_rate_round is the engine; public._sr_rate_round_json gives it
--   the TypeScript engine's JSON shape, for tests.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

-- Browsers never write rounds.
drop policy if exists "Allow public insert access" on public.player_matches;
revoke insert, update, delete, truncate on public.player_matches from anon, authenticated;
do $$
begin
  execute pg_catalog.format('revoke all on sequence %s from anon, authenticated',
    pg_catalog.pg_get_serial_sequence('public.player_matches', 'id'));
end;
$$;

-- Rows filed under a linked name that never got a profile of its own.
create temporary table sr_reattributed on commit drop as
  select m.player_name as alias, min(p.name) as profile
  from (select distinct x.player_name from public.player_matches x
    where not exists (select 1 from public.players p where p.name = x.player_name)) m
  join public.players p on pg_catalog.lower(p.name) = pg_catalog.lower(m.player_name)
    or exists (select 1 from pg_catalog.unnest(p.previous_names) a where pg_catalog.lower(a) = pg_catalog.lower(m.player_name))
    or exists (select 1 from pg_catalog.jsonb_array_elements_text(coalesce(pg_catalog.to_jsonb(p.bnet_accounts), '[]'::jsonb)) a
      where pg_catalog.lower(a) = pg_catalog.lower(m.player_name))
  group by m.player_name having count(distinct p.name) = 1;
update public.player_matches m set player_name = r.profile from sr_reattributed r where m.player_name = r.alias;
update public.player_history h set player_name = r.profile from sr_reattributed r where h.player_name = r.alias;
select public._refresh_player_daily_history(array_agg(profile)) from sr_reattributed having count(*) > 0;

-- Parameters are data: every rating names the version it was computed with,
-- and changing the active version replays everything. settings holds the
-- engine's SrSettings, with the same keys.
create table public.rating_params (
  version integer primary key check (version > 0),
  d double precision not null check (d > 0),
  beta double precision not null check (beta >= 0 and beta < 1),
  settings jsonb not null check (pg_catalog.jsonb_typeof(settings) = 'object'),
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
  full_rounds integer not null,
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
  full_round boolean not null,
  sr_before double precision not null,
  sr_after double precision not null,
  uncertainty_before double precision not null,
  uncertainty_after double precision not null,
  expected_share double precision not null,
  actual_share double precision not null,
  performance double precision not null,
  rated_weight double precision not null,
  full_rounds integer not null,
  primary key (match_id, player_name)
);
create index rating_events_round_order_idx on public.rating_events (played_at, match_id);
create index rating_events_player_idx on public.rating_events (player_name, played_at desc);

-- Lobby strength per round given to the engine (null with fewer than two
-- eligible players).
create table public.round_ratings (
  match_id uuid primary key,
  played_at timestamptz not null,
  params_version integer not null references public.rating_params(version),
  lobby_players integer not null,
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

-- Version 1, chosen by the backtest of 4 November 2026
-- (docs/briefs/01-skill-rating.md, "Backtest"); the same values as
-- DEFAULT_SR_PARAMS in supabase/functions/_shared/sr.ts.
insert into public.rating_params (version, d, beta, settings, active, note) values (1, 300, 0.05,
  '{"shareCurve": "raw", "logisticScale": 10, "m": 12, "rd0": 160, "rdMin": 30, "surpriseCap": 0.25,
    "start": "default", "startSr": 1500, "seedUncertainty": 150, "minActiveSeconds": 30,
    "minShotsPerMinute": 2, "fullRoundGraceSeconds": 10, "cautiousFactor": 2, "placementUncertainty": 30}',
  true, 'Chosen by the backtest of 4 November 2026 (docs/briefs/01-skill-rating.md, Backtest)');

-- Input assembly: stored rounds from p_from on, in rating order (round time,
-- then match_id as text), as arrays in participant order. _sr_round_inputs
-- gives the same rounds in the engine's JSON shape.
-- * A round's time is the earliest played_at of its rows.
-- * One participant per profile: rows of one profile in a round are merged
--   (kills summed). v1: time present is the longest row's time in lobby; v2:
--   the union of the profile's sessions. Participants are ordered by their
--   first row id, which renames don't change. pidx numbers the profiles
--   across all the rounds returned.
-- * Rows of banned players and rows without a profile are left out.
-- * v1: round length is the total match time (else the longest time in
--   lobby), time present is capped at it, and the interval is [L - present, L].
--   A v1 round whose rows disagree on the match time is several files that an
--   old importer gave one round id, and is not rated.
-- * v2: round length and winner come from the raw log; sessions are clipped
--   to [0, L]; overlapping sessions of one profile count once.
-- * Winner: v2, the profile whose session carries the logged winner's name;
--   v1, the sole top scorer with at least 50 kills; otherwise null.
create function public._sr_round_rows(p_from timestamptz default '-infinity')
returns table (match_id uuid, played_at timestamptz, length double precision, winner_pos integer,
  names text[], pidx integer[], kills double precision[], present double precision[], afk double precision[],
  shots double precision[], iv_count integer[], iv_start double precision[], iv_end double precision[])
-- Hash and merge joins only: with stale statistics the CTEs are estimated at
-- one row, and nested loops over them turn quadratic.
language sql stable security definer set search_path = '' set enable_nestloop = off as $$
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
    select x.match_id, x.player_name, sum(x.b - x.a)::double precision as present
    from spans x group by x.match_id, x.player_name
  ),
  people as (
    select r.match_id, r.player_name, min(r.id) as first_id, sum(r.score)::double precision as kills,
      max(r.time_in_lobby) as longest, coalesce(sum(r.afk_seconds), 0)::double precision as afk,
      sum(r.shots)::double precision as shots
    from rows r group by r.match_id, r.player_name
  ),
  participants as (
    select e.match_id, e.player_name, e.kills,
      pg_catalog.row_number() over (partition by e.match_id order by e.first_id)::integer as pos,
      pg_catalog.dense_rank() over (order by e.player_name collate "C")::integer as pidx,
      case when s.v2 and v.present is not null then v.present else least(e.longest, s.length) end as present,
      case when s.v2 then e.afk else 0 end as afk,
      case when s.v2 then e.shots end as shots,
      s.v2 and v.present is not null as from_sessions, s.length
    from people e join shaped s on s.match_id = e.match_id
    left join presence v on v.match_id = e.match_id and v.player_name = e.player_name
  ),
  intervals as (
    select p.match_id, p.pos, x.a::double precision as a, x.b::double precision as b
    from participants p join spans x on x.match_id = p.match_id and x.player_name = p.player_name
    where p.from_sessions
    union all
    select p.match_id, p.pos, p.length - p.present, p.length from participants p where not p.from_sessions
  ),
  counts as (
    select x.match_id, x.pos, count(*)::integer as n from intervals x group by x.match_id, x.pos
  ),
  flat as (
    select x.match_id, pg_catalog.array_agg(x.a order by x.pos, x.a, x.b) as iv_start,
      pg_catalog.array_agg(x.b order by x.pos, x.a, x.b) as iv_end
    from intervals x group by x.match_id
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
  ),
  winners as (
    select p.match_id, p.pos from participants p
    left join v2_winners w2 on w2.match_id = p.match_id
    left join v1_winners w1 on w1.match_id = p.match_id
    where p.player_name = coalesce(w2.player_name, w1.player_name)
  )
  select s.match_id, s.played_at, s.length, w.pos,
    pg_catalog.array_agg(p.player_name order by p.pos), pg_catalog.array_agg(p.pidx order by p.pos),
    pg_catalog.array_agg(p.kills order by p.pos), pg_catalog.array_agg(p.present order by p.pos),
    pg_catalog.array_agg(p.afk order by p.pos), pg_catalog.array_agg(p.shots order by p.pos),
    pg_catalog.array_agg(c.n order by p.pos), f.iv_start, f.iv_end
  from shaped s
  join participants p on p.match_id = s.match_id
  join counts c on c.match_id = p.match_id and c.pos = p.pos
  join flat f on f.match_id = s.match_id
  left join winners w on w.match_id = s.match_id
  group by s.match_id, s.played_at, s.length, w.pos, f.iv_start, f.iv_end
  order by s.played_at, s.match_id::text collate "C";
$$;

-- The same rounds in the engine's SrRound shape:
--   {id, playedAt, length, winner, participants: [{name, kills, present, afk,
--    shots, intervals: [[start, end], ...]}]}
create function public._sr_round_inputs(p_from timestamptz default '-infinity')
returns table (match_id uuid, played_at timestamptz, round jsonb)
language sql stable security definer set search_path = '' set extra_float_digits = 3 as $$
  select r.match_id, r.played_at, pg_catalog.jsonb_build_object(
    'id', r.match_id,
    'playedAt', pg_catalog.to_char(r.played_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'length', r.length,
    'winner', r.names[r.winner_pos],
    'participants', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name', r.names[o.k], 'kills', r.kills[o.k], 'present', r.present[o.k], 'afk', r.afk[o.k],
        'shots', r.shots[o.k], 'intervals', (
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.iv_start[t], r.iv_end[t]) order by t)
          from pg_catalog.generate_series(o.off + 1, o.off + r.iv_count[o.k]) t)) order by o.k)
      from (select k, coalesce(sum(r.iv_count[k]) over (order by k rows between unbounded preceding and 1 preceding), 0)::integer as off
        from pg_catalog.generate_subscripts(r.names, 1) k) o))
  from public._sr_round_rows(p_from) r
  order by r.played_at, r.match_id::text collate "C";
$$;

-- A new player's state before their first round ({sr, uncertainty,
-- ratedWeight, fullRounds, lastRatedAt}). Only the default start is used;
-- a seeded start has no seed table to read and is rejected.
create function public._sr_start_state(p_params public.rating_params)
returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if p_params.settings ->> 'start' = 'seed' then raise exception 'seed_required'; end if;
  return pg_catalog.jsonb_build_object(
    'sr', (p_params.settings ->> 'startSr')::double precision,
    'uncertainty', (p_params.settings ->> 'rd0')::double precision,
    'ratedWeight', 0, 'fullRounds', 0, 'lastRatedAt', null);
end;
$$;

-- The engine's per-round result. ev_* hold one entry per rated player, in
-- participant order; ev_pos is the participant's position.
create type public._sr_round_result as (
  ev_pos integer[], ev_weight double precision[], ev_full boolean[],
  ev_sr double precision[], ev_uncertainty double precision[],
  ev_expected double precision[], ev_actual double precision[],
  lobby_players integer, lobby_mean double precision, lobby_min double precision, lobby_max double precision
);

-- The rating engine for one round: a port of rateRound in
-- supabase/functions/_shared/sr.ts, evaluating the same formulas in the same
-- order (participants in the given order, pairs (i, j) with i before j, every
-- sum in that order), so results agree with it to rounding in pow/exp.
-- Participant k has p_iv_count[k] intervals, stored consecutively in
-- p_iv_start/p_iv_end. p_sr and p_uncertainty are the pre-round values.
-- Edit this together with sr.ts; tests/skill-rating.test.ts compares them.
create function public._sr_rate_round(p_params public.rating_params, p_length double precision, p_winner integer,
  p_kills double precision[], p_present double precision[], p_afk double precision[], p_shots double precision[],
  p_iv_count integer[], p_iv_start double precision[], p_iv_end double precision[],
  p_sr double precision[], p_uncertainty double precision[])
returns public._sr_round_result language plpgsql immutable set search_path = '' as $$
declare
  st jsonb := p_params.settings;
  d double precision := p_params.d;
  beta double precision := p_params.beta;
  min_active double precision := (st ->> 'minActiveSeconds')::double precision;
  min_shots double precision := (st ->> 'minShotsPerMinute')::double precision;
  m double precision := (st ->> 'm')::double precision;
  rd_min double precision := (st ->> 'rdMin')::double precision;
  cap double precision := (st ->> 'surpriseCap')::double precision;
  logistic boolean := st ->> 'shareCurve' = 'logistic';
  logistic_scale double precision := (st ->> 'logisticScale')::double precision;
  grace double precision := (st ->> 'fullRoundGraceSeconds')::double precision;
  q double precision := 2.302585092994046 / d; -- Math.LN10 / d
  pi2 double precision := pi() * pi();
  n integer := coalesce(pg_catalog.cardinality(p_kills), 0);
  res public._sr_round_result;
  -- eligible entries, in participant order
  ne integer := 0;
  e_pos integer[]; e_kills double precision[]; e_w double precision[]; e_active double precision[];
  e_span double precision[]; e_sr double precision[]; e_u double precision[]; e_g double precision[];
  e_off integer[]; e_cnt integer[];
  s1 double precision[]; s2 double precision[]; sw double precision[]; ss double precision[];
  se double precision[]; np integer[];
  -- normalised intervals of all entries
  iv_s double precision[] := '{}'; iv_e double precision[] := '{}'; niv integer := 0;
  cs double precision[]; ce double precision[]; c integer;
  k integer; t integer; u integer; off integer := 0; active double precision; span double precision;
  ts double precision; te double precision; first integer;
  i integer; j integer; wi integer := 0; scale double precision;
  a_off integer; a_cnt integer; a_k double precision; a_span double precision; a_w double precision;
  a_sr double precision; a_g double precision;
  a1 double precision; a2 double precision; aw double precision; aas double precision; ae double precision; an integer;
  b_off integer; b_cnt integer; b_g double precision;
  shared double precision; ka double precision; kb double precision; sh double precision; sb double precision;
  pw double precision; ea double precision; eb double precision; da double precision; db double precision;
  x double precision; inv double precision; wsum double precision; wsr double precision;
  lo double precision; hi double precision;
begin
  res.ev_pos := '{}'; res.ev_weight := '{}'; res.ev_full := '{}'; res.ev_sr := '{}';
  res.ev_uncertainty := '{}'; res.ev_expected := '{}'; res.ev_actual := '{}';
  if not (p_length > 0) then return res; end if;

  for k in 1..n loop
    c := p_iv_count[k];
    active := greatest(0::double precision, p_present[k] - p_afk[k]);
    if active < min_active or (p_shots[k] is not null and p_shots[k] * 60 < min_shots * active) then
      off := off + c;
      continue;
    end if;
    -- normaliseIntervals: drop empty ones, sort by (start, end), merge.
    cs := '{}'; ce := '{}'; u := 0;
    for t in off + 1..off + c loop
      if p_iv_end[t] > p_iv_start[t] then
        u := u + 1; cs[u] := p_iv_start[t]; ce[u] := p_iv_end[t];
        j := u;
        while j > 1 and (cs[j - 1] > cs[j] or (cs[j - 1] = cs[j] and ce[j - 1] > ce[j])) loop
          ts := cs[j]; te := ce[j]; cs[j] := cs[j - 1]; ce[j] := ce[j - 1]; cs[j - 1] := ts; ce[j - 1] := te;
          j := j - 1;
        end loop;
      end if;
    end loop;
    off := off + c;
    ne := ne + 1;
    first := niv + 1;
    span := 0;
    for t in 1..u loop
      if niv >= first and cs[t] <= iv_e[niv] then
        iv_e[niv] := greatest(iv_e[niv], ce[t]);
      else
        niv := niv + 1; iv_s[niv] := cs[t]; iv_e[niv] := ce[t];
      end if;
    end loop;
    for t in first..niv loop span := span + (iv_e[t] - iv_s[t]); end loop;
    e_pos[ne] := k; e_kills[ne] := p_kills[k]; e_w[ne] := least(1, active / p_length); e_active[ne] := active;
    e_span[ne] := span; e_off[ne] := first; e_cnt[ne] := niv - first + 1;
    e_sr[ne] := p_sr[k]; e_u[ne] := p_uncertainty[k];
    e_g[ne] := 1 / sqrt(1 + 3 * q * q * p_uncertainty[k] * p_uncertainty[k] / pi2);
    s1[ne] := 0; s2[ne] := 0; sw[ne] := 0; ss[ne] := 0; se[ne] := 0; np[ne] := 0;
    if k = p_winner then wi := ne; end if;
  end loop;
  res.lobby_players := ne;
  if ne < 2 then res.lobby_players := null; return res; end if;

  scale := m / (ne - 1);
  for i in 1..ne - 1 loop
    a_off := e_off[i]; a_cnt := e_cnt[i]; a_k := e_kills[i]; a_span := e_span[i]; a_w := e_w[i];
    a_sr := e_sr[i]; a_g := e_g[i];
    a1 := s1[i]; a2 := s2[i]; aw := sw[i]; aas := ss[i]; ae := se[i]; an := np[i];
    for j in i + 1..ne loop
      if a_cnt = 1 and e_cnt[j] = 1 then
        shared := greatest(0::double precision, least(iv_e[a_off], iv_e[e_off[j]]) - greatest(iv_s[a_off], iv_s[e_off[j]]));
      else
        shared := 0;
        b_off := e_off[j]; b_cnt := e_cnt[j];
        for t in a_off..a_off + a_cnt - 1 loop
          for u in b_off..b_off + b_cnt - 1 loop
            shared := shared + greatest(0::double precision, least(iv_e[t], iv_e[u]) - greatest(iv_s[t], iv_s[u]));
          end loop;
        end loop;
      end if;
      continue when shared <= 0;
      -- Each player's kills pro-rated to the time both were present.
      ka := a_k * shared / a_span;
      kb := e_kills[j] * shared / e_span[j];
      continue when ka + kb <= 0;
      sh := case when logistic then 1 / (1 + exp(-(ka - kb) / logistic_scale)) else ka / (ka + kb) end;
      if wi = i then sh := sh + beta * (1 - sh);
      elsif wi = j then sh := 1 - ((1 - sh) + beta * sh);
      end if;
      pw := least(shared / p_length, a_w, e_w[j]) * scale;
      b_g := e_g[j];
      ea := 1 / (1 + power(10::double precision, -b_g * (a_sr - e_sr[j]) / d));
      eb := 1 / (1 + power(10::double precision, -a_g * (e_sr[j] - a_sr) / d));
      -- Surprises, capped unless the cap is null; B's share is 1 - sh.
      da := case when cap is null then sh - ea else greatest(-cap, least(cap, sh - ea)) end;
      db := case when cap is null then (1 - sh) - eb else greatest(-cap, least(cap, (1 - sh) - eb)) end;
      x := pw * b_g;
      a1 := a1 + x * da; a2 := a2 + x * b_g * ea * (1 - ea); aw := aw + x; aas := aas + x * sh; ae := ae + x * ea;
      an := an + 1;
      x := pw * a_g;
      s1[j] := s1[j] + x * db; s2[j] := s2[j] + x * a_g * eb * (1 - eb); sw[j] := sw[j] + x;
      ss[j] := ss[j] + x * (1 - sh); se[j] := se[j] + x * eb; np[j] := np[j] + 1;
    end loop;
    s1[i] := a1; s2[i] := a2; sw[i] := aw; ss[i] := aas; se[i] := ae; np[i] := an;
  end loop;

  t := 0;
  for i in 1..ne loop
    continue when np[i] = 0;
    inv := 1 / (e_u[i] * e_u[i]) + q * q * s2[i];
    t := t + 1;
    res.ev_pos[t] := e_pos[i];
    res.ev_weight[t] := e_w[i];
    res.ev_full[t] := p_length - e_active[i] <= grace;
    res.ev_sr[t] := e_sr[i] + q / inv * s1[i];
    res.ev_uncertainty[t] := greatest(rd_min, sqrt(1 / inv));
    res.ev_expected[t] := se[i] / sw[i];
    res.ev_actual[t] := ss[i] / sw[i];
  end loop;

  wsum := 0; wsr := 0; lo := 'infinity'; hi := '-infinity';
  for i in 1..ne loop
    wsum := wsum + e_w[i]; wsr := wsr + e_w[i] * e_sr[i];
    lo := least(lo, e_sr[i]); hi := greatest(hi, e_sr[i]);
  end loop;
  res.lobby_mean := wsr / wsum; res.lobby_min := lo; res.lobby_max := hi;
  return res;
end;
$$;

-- rateRound's JSON shape, for comparing with sr.ts: takes an SrRound, the
-- pre-round states ({name: {sr, uncertainty, ...}}) and an optional seed map
-- ({name: sr}); returns {events: [SrEvent], lobby: {players, meanSr, minSr,
-- maxSr} | null}.
create function public._sr_rate_round_json(p_params public.rating_params, p_round jsonb, p_states jsonb,
  p_seed jsonb default null)
returns jsonb language plpgsql immutable set search_path = '' set extra_float_digits = 3 as $$
declare
  names text[]; kills double precision[]; present double precision[]; afk double precision[];
  shots double precision[]; counts integer[]; starts double precision[]; ends double precision[];
  srs double precision[]; uncertainties double precision[]; winner integer;
  res public._sr_round_result;
  seeded boolean := p_params.settings ->> 'start' = 'seed';
begin
  if seeded and p_seed is null then raise exception 'seed_required'; end if;
  select pg_catalog.array_agg(v ->> 'name' order by o), pg_catalog.array_agg((v ->> 'kills')::double precision order by o),
    pg_catalog.array_agg((v ->> 'present')::double precision order by o), pg_catalog.array_agg((v ->> 'afk')::double precision order by o),
    pg_catalog.array_agg((v ->> 'shots')::double precision order by o),
    pg_catalog.array_agg(pg_catalog.jsonb_array_length(v -> 'intervals') order by o),
    pg_catalog.array_agg(coalesce((p_states -> (v ->> 'name') ->> 'sr')::double precision,
      case when seeded then (p_seed ->> (v ->> 'name'))::double precision end,
      (p_params.settings ->> 'startSr')::double precision) order by o),
    pg_catalog.array_agg(coalesce((p_states -> (v ->> 'name') ->> 'uncertainty')::double precision,
      case when seeded and p_seed ? (v ->> 'name') then (p_params.settings ->> 'seedUncertainty')::double precision end,
      (p_params.settings ->> 'rd0')::double precision) order by o),
    min(o) filter (where v ->> 'name' = p_round ->> 'winner')
    into names, kills, present, afk, shots, counts, srs, uncertainties, winner
  from pg_catalog.jsonb_array_elements(p_round -> 'participants') with ordinality as x(v, o);
  select coalesce(pg_catalog.array_agg((iv ->> 0)::double precision order by o, io), '{}'),
    coalesce(pg_catalog.array_agg((iv ->> 1)::double precision order by o, io), '{}')
    into starts, ends
  from pg_catalog.jsonb_array_elements(p_round -> 'participants') with ordinality as x(v, o),
    pg_catalog.jsonb_array_elements(v -> 'intervals') with ordinality as y(iv, io);
  res := public._sr_rate_round(p_params, (p_round ->> 'length')::double precision, winner,
    kills, present, afk, shots, counts, starts, ends, srs, uncertainties);
  return pg_catalog.jsonb_build_object(
    'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', names[res.ev_pos[t]], 'weight', res.ev_weight[t], 'full', res.ev_full[t],
      'srBefore', srs[res.ev_pos[t]], 'srAfter', res.ev_sr[t],
      'uncertaintyBefore', uncertainties[res.ev_pos[t]], 'uncertaintyAfter', res.ev_uncertainty[t],
      'expectedShare', res.ev_expected[t], 'actualShare', res.ev_actual[t],
      'performance', res.ev_actual[t] - res.ev_expected[t]) order by t)
      from pg_catalog.generate_subscripts(res.ev_pos, 1) t), '[]'),
    'lobby', case when res.lobby_players is not null then pg_catalog.jsonb_build_object(
      'players', res.lobby_players, 'meanSr', res.lobby_mean, 'minSr', res.lobby_min, 'maxSr', res.lobby_max) end);
end;
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
-- start fresh), rates the rounds in order with the state held in memory,
-- writes the results and refreshes the standings. Returns the number of
-- rounds rated; a no-op when nothing is at or after p_from. Restored states
-- pass through jsonb, so floats are printed in full whatever the session's
-- extra_float_digits (Supabase uses 0, which keeps only 15 digits).
create function public.replay_ratings(p_from timestamptz default '-infinity')
returns integer language plpgsql security definer set search_path = '' set extra_float_digits = 3 as $$
declare
  params public.rating_params%rowtype;
  start_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  start_sr double precision; start_u double precision; placed_below double precision; cautious double precision;
  touched text[];
  states jsonb;
  item record;
  res public._sr_round_result;
  v jsonb;
  k integer; e integer; p integer; pos integer; n integer;
  -- state by pidx
  known boolean[] := '{}'; rated boolean[] := '{}'; st_name text[] := '{}';
  st_sr double precision[] := '{}'; st_u double precision[] := '{}'; st_rw double precision[] := '{}';
  st_fr integer[] := '{}'; st_last timestamptz[] := '{}';
  pre_sr double precision[]; pre_u double precision[];
  -- events
  ec integer := 0;
  ev_match uuid[] := '{}'; ev_at timestamptz[] := '{}'; ev_name text[] := '{}'; ev_w double precision[] := '{}';
  ev_full boolean[] := '{}'; ev_srb double precision[] := '{}'; ev_sra double precision[] := '{}';
  ev_ub double precision[] := '{}'; ev_ua double precision[] := '{}'; ev_exp double precision[] := '{}';
  ev_act double precision[] := '{}'; ev_rw double precision[] := '{}'; ev_fr integer[] := '{}';
  fc integer := 0;
  f_name text[] := '{}'; f_sr double precision[] := '{}'; f_u double precision[] := '{}';
  f_rw double precision[] := '{}'; f_fr integer[] := '{}'; f_last timestamptz[] := '{}';
  -- rounds
  rc integer := 0;
  r_match uuid[] := '{}'; r_at timestamptz[] := '{}'; r_players integer[] := '{}'; r_mean double precision[] := '{}';
  r_min double precision[] := '{}'; r_max double precision[] := '{}'; r_rated integer[] := '{}';
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
  start_sr := (public._sr_start_state(params) ->> 'sr')::double precision;
  start_u := (params.settings ->> 'rd0')::double precision;
  placed_below := (params.settings ->> 'placementUncertainty')::double precision;
  cautious := (params.settings ->> 'cautiousFactor')::double precision;

  with removed as (delete from public.rating_events where played_at >= start_from returning player_name)
    select pg_catalog.array_agg(distinct player_name) into touched from removed;
  delete from public.round_ratings where played_at >= start_from;
  if touched is not null then
    delete from public.player_ratings where player_name = any(touched);
    insert into public.player_ratings (player_name, sr, uncertainty, cautious_sr, placed, rank,
      rated_weight, full_rounds, last_rated_at)
    select distinct on (e.player_name) e.player_name, e.sr_after, e.uncertainty_after,
      e.sr_after - cautious * e.uncertainty_after, e.uncertainty_after <= placed_below, null,
      e.rated_weight, e.full_rounds, e.played_at
    from public.rating_events e where e.player_name = any(touched)
    order by e.player_name, e.played_at desc, e.match_id::text collate "C" desc;
  end if;
  -- States of the players who appear from here on.
  select pg_catalog.jsonb_object_agg(r.player_name, pg_catalog.jsonb_build_array(r.sr, r.uncertainty, r.rated_weight,
      r.full_rounds, r.last_rated_at))
    into states
  from public.player_ratings r
  where r.player_name in (select m.player_name from public.player_matches m where m.played_at >= start_from);

  for item in select * from public._sr_round_rows(start_from) i order by i.played_at, i.match_id::text collate "C" loop
    n := pg_catalog.cardinality(item.names);
    pre_sr := '{}'; pre_u := '{}';
    for k in 1..n loop
      p := item.pidx[k];
      if known[p] is null then
        known[p] := true; st_name[p] := item.names[k];
        v := states -> item.names[k];
        if v is null then
          st_sr[p] := start_sr; st_u[p] := start_u; st_rw[p] := 0; st_fr[p] := 0; st_last[p] := null;
        else
          st_sr[p] := (v ->> 0)::double precision; st_u[p] := (v ->> 1)::double precision;
          st_rw[p] := (v ->> 2)::double precision; st_fr[p] := (v ->> 3)::integer; st_last[p] := (v ->> 4)::timestamptz;
        end if;
      end if;
      pre_sr[k] := st_sr[p]; pre_u[k] := st_u[p];
    end loop;
    res := public._sr_rate_round(params, item.length, item.winner_pos, item.kills, item.present, item.afk,
      item.shots, item.iv_count, item.iv_start, item.iv_end, pre_sr, pre_u);
    for e in 1..coalesce(pg_catalog.cardinality(res.ev_pos), 0) loop
      pos := res.ev_pos[e]; p := item.pidx[pos];
      st_sr[p] := res.ev_sr[e]; st_u[p] := res.ev_uncertainty[e];
      st_rw[p] := st_rw[p] + res.ev_weight[e];
      if res.ev_full[e] then st_fr[p] := st_fr[p] + 1; end if;
      st_last[p] := item.played_at; rated[p] := true;
      ec := ec + 1;
      ev_match[ec] := item.match_id; ev_at[ec] := item.played_at; ev_name[ec] := item.names[pos]; ev_w[ec] := res.ev_weight[e];
      ev_full[ec] := res.ev_full[e]; ev_srb[ec] := pre_sr[pos]; ev_sra[ec] := res.ev_sr[e];
      ev_ub[ec] := pre_u[pos]; ev_ua[ec] := res.ev_uncertainty[e];
      ev_exp[ec] := res.ev_expected[e]; ev_act[ec] := res.ev_actual[e];
      ev_rw[ec] := st_rw[p]; ev_fr[ec] := st_fr[p];
    end loop;
    rc := rc + 1;
    r_match[rc] := item.match_id; r_at[rc] := item.played_at; r_players[rc] := coalesce(res.lobby_players, 0);
    r_mean[rc] := res.lobby_mean; r_min[rc] := res.lobby_min; r_max[rc] := res.lobby_max;
    r_rated[rc] := coalesce(pg_catalog.cardinality(res.ev_pos), 0);
  end loop;

  insert into public.rating_events (match_id, player_name, played_at, params_version, weight, full_round,
    sr_before, sr_after, uncertainty_before, uncertainty_after, expected_share, actual_share, performance,
    rated_weight, full_rounds)
  select x.m, x.name, x.at, params.version, x.w, x.f, x.srb, x.sra, x.ub, x.ua, x.ex, x.ac, x.ac - x.ex, x.rw, x.fr
  from unnest(ev_match, ev_at, ev_name, ev_w, ev_full, ev_srb, ev_sra, ev_ub, ev_ua, ev_exp, ev_act, ev_rw, ev_fr)
    as x(m, at, name, w, f, srb, sra, ub, ua, ex, ac, rw, fr);
  -- Final states, gathered here: subscripting these sparse arrays inside SQL
  -- would walk them element by element for every row.
  for p in 1..coalesce(pg_catalog.array_upper(rated, 1), 0) loop
    if rated[p] then
      fc := fc + 1;
      f_name[fc] := st_name[p]; f_sr[fc] := st_sr[p]; f_u[fc] := st_u[p]; f_rw[fc] := st_rw[p];
      f_fr[fc] := st_fr[p]; f_last[fc] := st_last[p];
    end if;
  end loop;
  insert into public.player_ratings (player_name, sr, uncertainty, cautious_sr, placed, rank,
    rated_weight, full_rounds, last_rated_at)
  select x.name, x.sr, x.u, x.sr - cautious * x.u, x.u <= placed_below, null, x.rw, x.fr, x.last
  from unnest(f_name, f_sr, f_u, f_rw, f_fr, f_last) as x(name, sr, u, rw, fr, last)
  on conflict (player_name) do update set sr = excluded.sr, uncertainty = excluded.uncertainty,
    cautious_sr = excluded.cautious_sr, placed = excluded.placed, rated_weight = excluded.rated_weight,
    full_rounds = excluded.full_rounds, last_rated_at = excluded.last_rated_at;
  insert into public.round_ratings (match_id, played_at, params_version, lobby_players, lobby_sr_mean,
    lobby_sr_min, lobby_sr_max, rated_players)
  select x.m, x.at, params.version, x.n, x.mean, x.lo, x.hi, x.rated
  from unnest(r_match, r_at, r_players, r_mean, r_min, r_max, r_rated) as x(m, at, n, mean, lo, hi, rated);
  perform public._sr_refresh_standings();
  return rc;
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

-- player_sessions and raw_logs: a correction to what input assembly reads
-- (session intervals and names; a log's format, round length and winner)
-- replays from that round. An import writes its raw logs before the round's
-- rows, so they queue nothing, and its sessions queue the same round as its
-- rows; sessions deleted with their rows queue nothing either.
create function public._sr_round_details_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ids uuid[];
begin
  if tg_op = 'INSERT' then
    select pg_catalog.array_agg(distinct match_id) into ids from new_rows;
  elsif tg_op = 'DELETE' then
    select pg_catalog.array_agg(distinct match_id) into ids from old_rows;
  elsif tg_table_name = 'player_sessions' then
    select pg_catalog.array_agg(distinct x.m) into ids
    from old_rows o join new_rows n on n.id = o.id cross join lateral (values (o.match_id), (n.match_id)) x(m)
    where (o.match_id, o.participation_id, o.start_s, o.end_s, o.logged_name)
      is distinct from (n.match_id, n.participation_id, n.start_s, n.end_s, n.logged_name);
  else
    select pg_catalog.array_agg(distinct x.m) into ids
    from old_rows o join new_rows n on n.id = o.id cross join lateral (values (o.match_id), (n.match_id)) x(m)
    where (o.match_id, o.format_version, o.round_length, o.winner_name)
      is distinct from (n.match_id, n.format_version, n.round_length, n.winner_name);
  end if;
  if ids is not null then
    perform public._sr_request_replay((select min(m.played_at) from public.player_matches m where m.match_id = any(ids)));
  end if;
  return null;
end;
$$;
create trigger sr_sessions_inserted after insert on public.player_sessions
  referencing new table as new_rows for each statement execute function public._sr_round_details_changed();
create trigger sr_sessions_updated after update on public.player_sessions
  referencing old table as old_rows new table as new_rows for each statement execute function public._sr_round_details_changed();
create trigger sr_sessions_deleted after delete on public.player_sessions
  referencing old table as old_rows for each statement execute function public._sr_round_details_changed();
create trigger sr_raw_logs_inserted after insert on public.raw_logs
  referencing new table as new_rows for each statement execute function public._sr_round_details_changed();
create trigger sr_raw_logs_updated after update on public.raw_logs
  referencing old table as old_rows new table as new_rows for each statement execute function public._sr_round_details_changed();
create trigger sr_raw_logs_deleted after delete on public.raw_logs
  referencing old table as old_rows for each statement execute function public._sr_round_details_changed();

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

-- A rename onto a name that already has rows (filed under it without a
-- profile, so unrated) makes them this profile's: replay from their first
-- round. Fires before sync_player_history_name moves the profile's own rows,
-- which the player_matches hook handles (relabelling only if no such rows).
create function public._sr_player_renamed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._sr_request_replay(public._sr_first_round_of(array[new.name]));
  return null;
end;
$$;
create trigger sr_player_renamed after update of name on public.players
  for each row when (old.name is distinct from new.name) execute function public._sr_player_renamed();

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

revoke all on function public._sr_round_rows(timestamptz), public._sr_round_inputs(timestamptz),
  public._sr_start_state(public.rating_params),
  public._sr_rate_round(public.rating_params, double precision, integer, double precision[], double precision[],
    double precision[], double precision[], integer[], double precision[], double precision[], double precision[], double precision[]),
  public._sr_rate_round_json(public.rating_params, jsonb, jsonb, jsonb), public._sr_refresh_standings(),
  public.replay_ratings(timestamptz), public._sr_request_replay(timestamptz), public._sr_first_round_of(text[]),
  public._sr_run_queued_replay(), public._sr_matches_changed(), public._sr_player_ban_changed(),
  public._sr_players_added_or_removed(), public._sr_params_changed(), public._sr_player_renamed(),
  public._sr_round_details_changed()
  from public, anon, authenticated, service_role;
grant execute on function public.replay_ratings(timestamptz) to service_role;

-- Rate the whole history once.
select public.replay_ratings();

notify pgrst, 'reload schema';
commit;
