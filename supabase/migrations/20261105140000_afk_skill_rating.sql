-- PR #3: exclude known v4 AFK periods from opponents and concurrent size.
-- Requires PR #2 afk_intervals plus rolling SR. Apply staging then production.
-- Legacy NULL timelines retain prior results. No parameter/formula changes.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

create function public._sr_afk_intervals(p_match uuid, p_names text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg((select coalesce(jsonb_agg(jsonb_build_object(
    'start', b -> 'start_s', 'end', b -> 'end_s', 'terminal', b -> 'terminal')
    order by s.session_no, bo), '[]')
    from public.player_sessions s join public.player_matches m on m.id = s.participation_id
    cross join lateral jsonb_array_elements(s.afk_intervals) with ordinality breaks(b,bo)
    where m.match_id = p_match and m.player_name = name
      and exists (select 1 from public.raw_logs l where l.match_id = p_match and l.format_version = 4)) order by no), '[]')
  from unnest(p_names) with ordinality people(name,no);
$$;

-- Complements for the configurable time fallback. Endpoints have zero measure
-- here; scoring below separately retains the terminal-point distinction.
create function public._sr_active_spans(intervals jsonb, periods jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare output jsonb := '[]'; iv jsonb; period jsonb; a double precision; b double precision;
  x double precision; y double precision;
begin
  for iv in select * from jsonb_array_elements(intervals) loop
    a := (iv ->> 0)::double precision; b := (iv ->> 1)::double precision;
    for period in select value from jsonb_array_elements(coalesce(periods,'[]'))
      order by (value ->> 'start')::double precision, (value ->> 'end')::double precision loop
      x := (period ->> 'start')::double precision; y := (period ->> 'end')::double precision;
      continue when y <= a or x >= b;
      if x > a then output := output || jsonb_build_array(jsonb_build_array(a,x)); end if;
      a := greatest(a,y);
      exit when a >= b;
    end loop;
    if a < b then output := output || jsonb_build_array(jsonb_build_array(a,b)); end if;
  end loop;
  return output;
end;
$$;

-- Keep the established event engine and its validation/order/formulas. The
-- extra input only masks AFK participants at events, including a terminal
-- zero-duration point. Presence intervals still validate raw score history.
do $$
declare definition text := pg_get_functiondef('public._sr_rate_event_round(public.rating_params,double precision,integer,double precision[],double precision[],double precision[],double precision[],integer[],double precision[],double precision[],double precision[],double precision[],integer[],double precision[],double precision[])'::regprocedure);
  anchor text := 'if iv_s[u] <= event_at and event_at <= iv_e[u] then';
begin
  if position(anchor in definition) = 0 then raise exception 'Event engine changed'; end if;
  definition := replace(definition, '_sr_rate_event_round(', '_sr_rate_afk_event_round(');
  definition := replace(definition, 'p_event_delta double precision[])', 'p_event_delta double precision[], p_afk_intervals jsonb)');
  definition := replace(definition, anchor, 'if iv_s[u] <= event_at and event_at <= iv_e[u] and not exists (
    select 1 from jsonb_array_elements(coalesce(p_afk_intervals -> (e_pos[k] - 1), ''[]'')) b
    where (b ->> ''start'')::double precision <= event_at and
      (event_at < (b ->> ''end'')::double precision or
        coalesce((b ->> ''terminal'')::boolean,false) and event_at = (b ->> ''end'')::double precision)) then');
  definition := replace(definition, 'quality := public._sr_lobby_size_weight(cardinality(present_idx), st);',
    'continue when not (actor = any(present_idx));
    quality := public._sr_lobby_size_weight(cardinality(present_idx), st);');
  execute definition;
end;
$$;

-- JSON/reference path: add the AFK mask for scoring, or complement spans for
-- the time fallback while retaining present/AFK totals for eligibility.
do $$
declare definition text := pg_get_functiondef('public._sr_rate_round_json(public.rating_params,jsonb,jsonb,jsonb)'::regprocedure);
  anchor text := 'kills, present, afk, shots, counts, starts, ends, srs, uncertainties, actors, ats, deltas);';
begin
  if position(anchor in definition) = 0 then raise exception 'JSON engine changed'; end if;
  definition := replace(definition, 'public._sr_rate_event_round(', 'public._sr_rate_afk_event_round(');
  definition := replace(definition, anchor, 'kills, present, afk, shots, counts, starts, ends, srs, uncertainties, actors, ats, deltas,
    (select jsonb_agg(coalesce(p -> ''afkIntervals'', ''[]'') order by o)
      from jsonb_array_elements(p_round -> ''participants'') with ordinality people(p,o)));');
  definition := replace(definition, 'return public._sr_time_round_json(p_params, p_round, p_states, p_seed);',
    'return public._sr_time_round_json(p_params, p_round || jsonb_build_object(''participants'', (
      select jsonb_agg(p || jsonb_build_object(''intervals'', public._sr_active_spans(p -> ''intervals'', p -> ''afkIntervals'')) order by o)
      from jsonb_array_elements(p_round -> ''participants'') with ordinality people(p,o))), p_states, p_seed);');
  execute definition;
end;
$$;

-- Real replay path: for v4 supply the same mask as JSON. Legacy dispatch is
-- unchanged; fallback complements only known v4 breaks.
do $$
declare definition text := pg_get_functiondef('public._sr_rate_round_dispatch(public.rating_params,uuid,text[],double precision,integer,double precision[],double precision[],double precision[],double precision[],integer[],double precision[],double precision[],double precision[],double precision[])'::regprocedure);
begin
  definition := replace(definition, 'declare actors integer[]; ats double precision[]; deltas double precision[];',
    'declare actors integer[]; ats double precision[]; deltas double precision[];
      breaks jsonb; ivs jsonb; active_ivs jsonb; new_counts integer[] := ''{}'';
      new_starts double precision[] := ''{}''; new_ends double precision[] := ''{}'';
      k integer; t integer; off integer := 0; iv jsonb;');
  definition := replace(definition, E'begin\n  if public._sr_rolling_target', E'begin\n  breaks := public._sr_afk_intervals(p_match, p_names);\n  if exists (select 1 from public.raw_logs where match_id = p_match and format_version = 4) and exists (\n    select 1 from public.player_sessions s join public.player_matches m on m.id=s.participation_id\n    where m.match_id=p_match and s.afk_intervals is null) then raise exception ''incomplete_afk_intervals''; end if;\n  if public._sr_rolling_target');
  definition := replace(definition, 'format_version = 3', 'format_version in (3, 4)');
  definition := replace(definition, 'return public._sr_rate_round(p_params,',
    'for k in 1..coalesce(cardinality(p_names),0) loop
      ivs := ''[]'';
      for t in off + 1..off + p_iv_count[k] loop
        ivs := ivs || jsonb_build_array(jsonb_build_array(p_iv_start[t],p_iv_end[t])); end loop;
      off := off + p_iv_count[k];
      active_ivs := public._sr_active_spans(ivs, breaks -> (k-1));
      new_counts := array_append(new_counts,jsonb_array_length(active_ivs));
      for iv in select * from jsonb_array_elements(active_ivs) loop
        new_starts := array_append(new_starts,(iv ->> 0)::double precision);
        new_ends := array_append(new_ends,(iv ->> 1)::double precision); end loop;
    end loop;
    return public._sr_rate_round(p_params,');
  definition := replace(definition, 'p_iv_count, p_iv_start, p_iv_end, p_sr, p_uncertainty);',
    'new_counts, new_starts, new_ends, p_sr, p_uncertainty);');
  definition := replace(definition, 'return public._sr_rate_event_round(', 'return public._sr_rate_afk_event_round(');
  definition := replace(definition, 'p_sr, p_uncertainty, actors, ats, deltas);', 'p_sr, p_uncertainty, actors, ats, deltas, breaks);');
  execute definition;
end;
$$;

-- v4 shares exact presence/winner assembly and adds its explicit AFK mask.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public._sr_round_rows(timestamptz)'::regprocedure);
  if position('l.format_version in (2, 3)' in definition) = 0 then raise exception 'Round assembly changed'; end if;
  definition := replace(definition, 'l.format_version in (2, 3)', 'l.format_version in (2, 3, 4)');
  definition := replace(definition, 'case when s.v2 then e.afk else 0 end as afk',
    'case when exists (select 1 from public.raw_logs l where l.match_id=e.match_id and l.format_version=4)
      then coalesce((select sum(ps.afk_seconds)::double precision from public.player_sessions ps
        join rows r on r.id=ps.participation_id where r.match_id=e.match_id and r.player_name=e.player_name),e.afk)
      when s.v2 then e.afk else 0 end as afk');
  execute definition;
  definition := pg_get_functiondef('public._sr_round_inputs(timestamptz)'::regprocedure);
  definition := replace(definition, 'l.format_version = 3', 'l.format_version in (3, 4)');
  definition := replace(definition, 'p || jsonb_build_object(''scoreEvents'',',
    'p || case when l.format_version = 4 then jsonb_build_object(''afkIntervals'',
      public._sr_afk_intervals(r.match_id, array[p ->> ''name'']) -> 0) else ''{}''::jsonb end || jsonb_build_object(''scoreEvents'',');
  execute definition;
  definition := pg_get_functiondef('public._sr_round_details_changed()'::regprocedure);
  definition := replace(definition, 'o.end_s, o.logged_name)', 'o.end_s, o.logged_name, o.afk_intervals, o.afk_seconds)');
  definition := replace(definition, 'n.end_s, n.logged_name)', 'n.end_s, n.logged_name, n.afk_intervals, n.afk_seconds)');
  execute definition;
end;
$$;
revoke all on function public._sr_afk_intervals(uuid,text[]), public._sr_active_spans(jsonb,jsonb),
  public._sr_rate_afk_event_round(public.rating_params,double precision,integer,double precision[],double precision[],
    double precision[],double precision[],integer[],double precision[],double precision[],double precision[],double precision[],
    integer[],double precision[],double precision[],jsonb) from public,anon,authenticated,service_role;
select public._sr_request_replay('-infinity');
notify pgrst, 'reload schema';
commit;
