-- Brief 00: keep every uploaded log unchanged and import each file once (by
-- SHA-256), and store v2 player sessions and kill pairs
-- (docs/workshop-log-format.md). v2 rows weigh active play in ELO
-- (docs/ranking.md); v1 rows are unchanged.
--
-- Deploy in this order, staging first: this migration, then the upload-csv
-- Edge Function, then publish Workshop script v3.5.0. apply_match_import keeps
-- its old arguments, so the deployed function keeps working in between.
--
-- Sessions belong to their participation: deleting rounds (reset, player
-- deletion) removes them and their kill pairs. Raw logs are kept, so a file
-- imported before a reset is still reported as already imported.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
lock table public.players, public.player_matches, public.player_history in share row exclusive mode;

create table public.raw_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  filename text,
  host_name text,
  format_version smallint not null check (format_version in (1, 2)),
  script_version text,
  match_id uuid not null unique,
  round_length numeric,
  winner_name text,
  uploaded_at timestamptz not null default pg_catalog.now(),
  text text not null
);

alter table public.player_matches
  add column sessions smallint,
  add column status text check (status in ('present', 'left', 'kicked')),
  add column shots integer,
  add column hits integer,
  add column afk_seconds numeric;

-- v2 rows (with a status) weigh active play, time present minus AFK time, as a
-- share of the round; under 30 s of active play counts for nothing, which
-- drops fully AFK sessions and the AFK kick. v1 rows keep the existing rule.
-- Mirrored by scoreWeight in supabase/functions/_shared/elo-weight.ts.
create function public.match_elo_weight(p_kills numeric, p_time numeric, p_total numeric, p_status text, p_afk numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case when p_status is null then public.match_elo_weight(p_kills, p_time, p_total)
    when p_time - coalesce(p_afk, 0) < 30 then 0
    when p_total is null or p_total - (p_time - coalesce(p_afk, 0)) <= 10 then 1
    else least(1, (p_time - coalesce(p_afk, 0)) / p_total) end;
$$;
revoke all on function public.match_elo_weight(numeric, numeric, numeric, text, numeric) from public;
grant execute on function public.match_elo_weight(numeric, numeric, numeric, text, numeric) to anon, authenticated, service_role;
-- Existing rows have no status, so their weights don't change.
alter table public.player_matches alter column elo_weight set expression as
  (public.match_elo_weight(score::numeric, time_in_lobby::numeric, total_match_time::numeric, status, afk_seconds));

create table public.player_sessions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  match_id uuid not null,
  participation_id bigint not null references public.player_matches(id) on delete cascade,
  session_no smallint not null check (session_no >= 1),
  logged_name text not null,
  slot smallint not null,
  start_s numeric not null,
  end_s numeric not null,
  status text not null check (status in ('present', 'left', 'kicked')),
  kills integer not null,
  deaths integer not null,
  shots integer not null,
  hits integer not null,
  crouches integer not null,
  afk_seconds numeric not null,
  unique (match_id, session_no),
  check (end_s >= start_s)
);
create index player_sessions_participation_idx on public.player_sessions (participation_id);

create table public.round_kill_pairs (
  match_id uuid not null,
  killer_session_no smallint not null,
  victim_session_no smallint not null,
  kills integer not null check (kills > 0),
  primary key (match_id, killer_session_no, victim_session_no),
  foreign key (match_id, killer_session_no) references public.player_sessions(match_id, session_no) on delete cascade,
  foreign key (match_id, victim_session_no) references public.player_sessions(match_id, session_no) on delete cascade,
  check (killer_session_no <> victim_session_no)
);
create index round_kill_pairs_victim_idx on public.round_kill_pairs (match_id, victim_session_no);

alter table public.raw_logs enable row level security;
alter table public.player_sessions enable row level security;
alter table public.round_kill_pairs enable row level security;
revoke all on public.raw_logs, public.player_sessions, public.round_kill_pairs from public, anon, authenticated;
-- upload-csv reads stored hashes; everything else goes through apply_match_import.
grant select on public.raw_logs to service_role;

-- Same import as before, plus the raw logs, each participation's sessions
-- (nested as session_rows) and the round's kill pairs.
drop function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text);
create function public.apply_match_import(
  p_expected_revision bigint, p_players jsonb, p_ranks jsonb,
  p_history jsonb, p_matches jsonb, p_admin_user text, p_details text,
  p_raw_logs jsonb default '[]', p_kill_pairs jsonb default '[]'
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  current_revision bigint;
  imported_player public.players%rowtype;
  legacy_match_id uuid := pg_catalog.gen_random_uuid();
  banned_names text[];
  skipped_banned integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select revision into current_revision from public.leaderboard_state where singleton for update;
  if current_revision is null or current_revision is distinct from p_expected_revision then
    raise exception 'Leaderboard changed during upload. Please import the files again.' using errcode = '40001';
  end if;
  -- The caller skips stored hashes after reading the revision, so a clash here
  -- means another upload stored the file meanwhile; retrying skips it.
  begin
    insert into public.raw_logs (sha256, filename, host_name, format_version, script_version, match_id,
      round_length, winner_name, text)
    select r.sha256, r.filename, r.host_name, r.format_version, r.script_version, r.match_id,
      r.round_length, r.winner_name, r.text
    from pg_catalog.jsonb_populate_recordset(null::public.raw_logs, coalesce(p_raw_logs, '[]')) r;
  exception when unique_violation then
    raise exception 'A file in this upload was imported meanwhile. Please import the files again.' using errcode = '40001';
  end;
  select coalesce(array_agg(distinct lower(btrim(a.alias))), '{}'::text[]) into banned_names
  from public.players p cross join lateral (
    select p.name as alias
    union all select unnest(p.previous_names)
    union all select jsonb_array_elements_text(coalesce(to_jsonb(p.bnet_accounts),'[]'::jsonb))
  ) a where p.is_banned is true;
  select banned_names || coalesce(array_agg(distinct lower(btrim(m->>'player_name'))), '{}'::text[])
    into banned_names from jsonb_array_elements(p_matches) m
    where lower(btrim(m->>'player_name'))=any(banned_names)
      or lower(btrim(m->>'logged_player_name'))=any(banned_names);
  select count(*)::integer into skipped_banned from jsonb_array_elements(p_matches) m
    where lower(btrim(m->>'player_name'))=any(banned_names);
  -- Number the participations up front so their sessions can reference them.
  select coalesce(jsonb_agg(m || pg_catalog.jsonb_build_object('id',
      pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.player_matches', 'id')))), '[]'::jsonb)
    into p_matches from jsonb_array_elements(p_matches) m
    where not (lower(btrim(m->>'player_name'))=any(banned_names));
  select coalesce(jsonb_agg(p),'[]'::jsonb) into p_players from jsonb_array_elements(p_players) p
    where not (lower(btrim(p->>'name'))=any(banned_names));
  select coalesce(jsonb_agg(p),'[]'::jsonb) into p_ranks from jsonb_array_elements(p_ranks) p
    where not (lower(btrim(p->>'name'))=any(banned_names));
  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_players) loop
    update public.players set matches = imported_player.matches, score = imported_player.score, deaths = imported_player.deaths,
      kdr = imported_player.kdr, accuracy = imported_player.accuracy, kpm = imported_player.kpm, crouches = imported_player.crouches,
      time_in_lobby = imported_player.time_in_lobby, elo = imported_player.elo, rank = imported_player.rank, tag = imported_player.tag
      where name = imported_player.name;
    if not found then
    insert into public.players (name, matches, score, deaths, kdr, accuracy, kpm, crouches, time_in_lobby, elo, rank, tag, previous_names)
    values (imported_player.name, imported_player.matches, imported_player.score, imported_player.deaths,
      imported_player.kdr, imported_player.accuracy, imported_player.kpm, imported_player.crouches,
      imported_player.time_in_lobby, imported_player.elo, imported_player.rank, imported_player.tag,
      coalesce(imported_player.previous_names, '{}'));
    end if;
  end loop;
  update public.players p set rank = r.rank
    from pg_catalog.jsonb_populate_recordset(null::public.players, p_ranks) r
    where p.name = r.name and p.rank is distinct from r.rank;
  insert into public.player_matches (id, player_name, logged_player_name, score, deaths, accuracy, kpm, kdr,
    crouches, time_in_lobby, total_match_time, performance_score, played_at, match_id,
    sessions, status, shots, hits, afk_seconds)
  overriding system value
  select r.id, r.player_name, coalesce(r.logged_player_name, r.player_name),
    r.score, r.deaths, r.accuracy, r.kpm, r.kdr,
    r.crouches, r.time_in_lobby, r.total_match_time, r.performance_score,
    coalesce((m.value ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now()),
    coalesce(r.match_id, legacy_match_id),
    r.sessions, r.status, r.shots, r.hits, r.afk_seconds
  from pg_catalog.jsonb_array_elements(p_matches) m,
    lateral pg_catalog.jsonb_populate_record(null::public.player_matches, m.value) r;
  insert into public.player_sessions (match_id, participation_id, session_no, logged_name, slot, start_s, end_s,
    status, kills, deaths, shots, hits, crouches, afk_seconds)
  select (m.value ->> 'match_id')::uuid, (m.value ->> 'id')::bigint, s.session_no, s.logged_name, s.slot,
    s.start_s, s.end_s, s.status, s.kills, s.deaths, s.shots, s.hits, s.crouches, s.afk_seconds
  from pg_catalog.jsonb_array_elements(p_matches) m
  cross join lateral pg_catalog.jsonb_populate_recordset(null::public.player_sessions,
    coalesce(m.value -> 'session_rows', '[]')) s;
  -- Pairs with a skipped (banned) session are dropped along with it.
  insert into public.round_kill_pairs (match_id, killer_session_no, victim_session_no, kills)
  select k.match_id, k.killer_session_no, k.victim_session_no, k.kills
  from pg_catalog.jsonb_populate_recordset(null::public.round_kill_pairs, coalesce(p_kill_pairs, '[]')) k
  where exists (select 1 from public.player_sessions s where s.match_id = k.match_id and s.session_no = k.killer_session_no)
    and exists (select 1 from public.player_sessions s where s.match_id = k.match_id and s.session_no = k.victim_session_no);
  -- Stored match rows determine PB; use the final server ranking in history.
  perform public._rerank_players_by_pb();
  -- Insert one sample per eligible match using its performance_score and played_at timestamp.
  insert into public.player_history(player_name, elo, rank, created_at)
    select r.player_name,
      r.performance_score,
      coalesce(p.rank, 999999),
      coalesce((m.value ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now())
    from pg_catalog.jsonb_array_elements(p_matches) m
    cross join lateral pg_catalog.jsonb_populate_record(null::public.player_matches, m.value) r
    join public.players p on p.name = r.player_name
    where r.performance_score is not null
      and public.match_elo_weight(r.score::numeric, r.time_in_lobby::numeric, r.total_match_time::numeric,
        r.status, r.afk_seconds) > 0;
  insert into public.audit_logs (action, admin_user, details) values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, coalesce(p_details,'') || pg_catalog.format(' Database skipped %s banned participation(s).', skipped_banned));
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text, jsonb, jsonb) to service_role;

-- Match details also return the status and AFK time, so the site shows v2 weights.
create or replace function public.get_match_details(p_match_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_name', m.player_name, 'logged_player_name', coalesce(m.logged_player_name, m.player_name),
    'avatar_url', p.avatar_url, 'is_verified', coalesce(p.is_verified, false),
    'score', m.score, 'deaths', m.deaths, 'accuracy', m.accuracy, 'kpm', m.kpm, 'kdr', m.kdr,
    'crouches', m.crouches, 'time_in_lobby', m.time_in_lobby, 'total_match_time', m.total_match_time,
    'performance_score', m.performance_score, 'played_at', m.played_at,
    'status', m.status, 'afk_seconds', m.afk_seconds
  ) order by m.score desc, m.time_in_lobby asc, coalesce(m.logged_player_name, m.player_name) collate "C"), '[]'::jsonb)
  from public.player_matches m left join public.players p on p.name = m.player_name where m.match_id = p_match_id;
$$;
revoke all on function public.get_match_details(uuid) from public;
grant execute on function public.get_match_details(uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
