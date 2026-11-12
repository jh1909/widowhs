-- PR #2: Workshop v3.6.0 / log v3 adds timestamped score changes.
-- Deploy on staging first: this migration, upload-csv, then Workshop v3.6.0.
-- Old logs and old importer arguments remain valid. No existing data changes.
-- Score histories belong to sessions, so renames, bans and reset retain the
-- existing ownership/cascade behaviour. Victim moderation cannot erase a
-- legitimate killer's score history.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

alter table public.raw_logs drop constraint raw_logs_format_version_check;
alter table public.raw_logs add check (format_version in (1, 2, 3));
alter table public.player_sessions add column score_events jsonb;

-- Validate the same cumulative +1/-1 score history as the log parser. NULL
-- explicitly means an old log, whereas [] means a known scoreless v3 session.
create function public._valid_score_events(events jsonb, started numeric, ended numeric, final_score integer)
returns boolean language plpgsql immutable set search_path = '' as $$
declare event jsonb; at_s numeric; value integer; previous integer := 0; previous_at numeric := started;
begin
  if events is null then return true; end if;
  if pg_catalog.jsonb_typeof(events) is distinct from 'array' then return false; end if;
  for event in select * from pg_catalog.jsonb_array_elements(events) loop
    if pg_catalog.jsonb_typeof(event -> 'at_s') is distinct from 'number'
      or pg_catalog.jsonb_typeof(event -> 'score') is distinct from 'number' then return false; end if;
    at_s := (event ->> 'at_s')::numeric;
    if (event ->> 'score')::numeric <> trunc((event ->> 'score')::numeric) then return false; end if;
    value := (event ->> 'score')::integer;
    if at_s < previous_at or at_s > ended or value < 0 or abs(value - previous) <> 1 then return false; end if;
    previous_at := at_s; previous := value;
  end loop;
  return previous = final_score;
end;
$$;
alter table public.player_sessions add constraint valid_score_events
  check (public._valid_score_events(score_events, start_s, end_s, kills));
revoke all on function public._valid_score_events(jsonb, numeric, numeric, integer)
  from public, anon, authenticated, service_role;

-- Extend the established importer in place, retaining its signature, conflict
-- handling, locking and grants. Guard both anchors against schema drift.
do $$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.apply_match_import(bigint,jsonb,jsonb,jsonb,jsonb,text,text,jsonb,jsonb)'::regprocedure);
  columns text := 'status, kills, deaths, shots, hits, crouches, afk_seconds)';
  values_sql text := 's.start_s, s.end_s, s.status, s.kills, s.deaths, s.shots, s.hits, s.crouches, s.afk_seconds';
begin
  if position(columns in definition) = 0 or position(values_sql in definition) = 0 then
    raise exception 'apply_match_import definition changed; inspect timed score migration';
  end if;
  definition := replace(definition, columns, 'status, kills, deaths, shots, hits, crouches, afk_seconds, score_events)');
  definition := replace(definition, values_sql, values_sql || ', s.score_events');
  execute definition;
end;
$$;
notify pgrst, 'reload schema';
commit;
