-- PR #2: v4 / Workshop v3.7.0 records exact round-relative AFK breaks.
-- Deploy staging then production: migration, upload-csv, then Workshop.
-- NULL means unknown legacy timing; [] means a v4 session with no breaks.
-- Inspector independently rounds each endpoint/total to hundredths: allow
-- (break count + 1) hundredths of discrepancy, without shifting endpoints.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
alter table public.raw_logs drop constraint raw_logs_format_version_check;
alter table public.raw_logs add check (format_version in (1, 2, 3, 4));
alter table public.player_sessions add column afk_intervals jsonb;

create function public._valid_afk_intervals(periods jsonb, started numeric, ended numeric, total numeric)
returns boolean language plpgsql immutable set search_path = '' as $$
declare period jsonb; a numeric; b numeric; terminal boolean := false; previous numeric := started; duration numeric := 0;
begin
  if periods is null then return true; end if;
  if jsonb_typeof(periods) is distinct from 'array' then return false; end if;
  for period in select * from jsonb_array_elements(periods) loop
    if jsonb_typeof(period -> 'start_s') is distinct from 'number'
      or jsonb_typeof(period -> 'end_s') is distinct from 'number'
      or jsonb_typeof(period -> 'terminal') is distinct from 'boolean' then return false; end if;
    a := (period ->> 'start_s')::numeric; b := (period ->> 'end_s')::numeric;
    if terminal or a < previous or b < a or b > ended
      or (period ->> 'terminal')::boolean and b <> ended then return false; end if;
    terminal := (period ->> 'terminal')::boolean;
    previous := b; duration := duration + b - a;
  end loop;
  if jsonb_array_length(periods) = 0 then return total = 0; end if;
  return abs(duration - total) <= (jsonb_array_length(periods) + 1) * 0.01;
end;
$$;
alter table public.player_sessions add constraint valid_afk_intervals
  check (public._valid_afk_intervals(afk_intervals, start_s, end_s, afk_seconds));
revoke all on function public._valid_afk_intervals(jsonb,numeric,numeric,numeric)
  from public, anon, authenticated, service_role;

-- Retain signature, grants, revision conflicts and all transaction invariants.
do $$
declare definition text := pg_get_functiondef(
  'public.apply_match_import(bigint,jsonb,jsonb,jsonb,jsonb,text,text,jsonb,jsonb)'::regprocedure);
  columns text := 'afk_seconds, score_events)';
  values_sql text := 's.afk_seconds, s.score_events';
begin
  if position(columns in definition) = 0 or position(values_sql in definition) = 0 then
    raise exception 'apply_match_import definition changed; inspect AFK migration'; end if;
  definition := replace(definition, columns, 'afk_seconds, score_events, afk_intervals)');
  definition := replace(definition, values_sql, values_sql || ', s.afk_intervals');
  execute definition;
end;
$$;
-- Extend all PR #2 winning-session/PB/public result helpers to v4.
do $$
declare signature text; definition text;
begin
  if to_regprocedure('public._round_winning_session(uuid)') is null then return; end if;
  foreach signature in array array['public._round_winning_session(uuid)', 'public._player_personal_best(text)',
    'public.get_global_matches(integer,integer)', 'public.get_match_details(uuid)'] loop
    if to_regprocedure(signature) is not null then
      definition := pg_get_functiondef(to_regprocedure(signature));
      if position('l.format_version in (2, 3)' in definition) = 0 then
        raise exception 'Winner helper changed: %', signature; end if;
      execute replace(definition, 'l.format_version in (2, 3)', 'l.format_version in (2, 3, 4)');
    end if;
  end loop;
end;
$$;
notify pgrst, 'reload schema';
commit;
