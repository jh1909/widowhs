-- PR #3: scoring-based evidence for rolling lobbies (v3 logs).
-- Prerequisites: SR, lobby-size weighting, then PR #2 timed-score migration.
-- Staging before production. Activates parameter version 3 and replays history.
-- Older logs keep the v2 time model; timestamps cannot be reconstructed.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

create function public._sr_rolling_target(settings jsonb)
returns double precision language plpgsql immutable set search_path = '' as $$
declare target double precision; shots double precision;
begin
  if not (settings ? 'rollingEvidenceKills') then return null; end if;
  if jsonb_typeof(settings -> 'rollingEvidenceKills') is distinct from 'number' then
    raise exception 'invalid_rolling_evidence'; end if;
  target := (settings ->> 'rollingEvidenceKills')::double precision;
  if target < 1 or target <> trunc(target) or target > 9007199254740991 then raise exception 'invalid_rolling_evidence'; end if;
  if jsonb_typeof(settings -> 'rollingMinShots') is distinct from 'number' then raise exception 'invalid_rolling_evidence'; end if;
  shots := (settings ->> 'rollingMinShots')::double precision;
  if shots < 0 or shots <> trunc(shots) or shots > 9007199254740991 then raise exception 'invalid_rolling_evidence'; end if;
  return target;
end;
$$;

create or replace function public._sr_validate_lobby_size()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform public._sr_lobby_size_weight(2, new.settings);
  perform public._sr_rolling_target(new.settings);
  return new;
end;
$$;

create function public._sr_rate_event_round(p_params public.rating_params, p_length double precision, p_winner integer,
  p_kills double precision[], p_present double precision[], p_afk double precision[], p_shots double precision[],
  p_iv_count integer[], p_iv_start double precision[], p_iv_end double precision[],
  p_sr double precision[], p_uncertainty double precision[],
  p_event_actor integer[], p_event_at double precision[], p_event_delta double precision[])
returns public._sr_round_result language plpgsql immutable set search_path = '' as $$
declare
  st jsonb := p_params.settings;
  d double precision := p_params.d;
  beta double precision := p_params.beta;
  min_active double precision := (st ->> 'minActiveSeconds')::double precision;
  min_shots double precision := (st ->> 'rollingMinShots')::double precision;
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
  target double precision := public._sr_rolling_target(st);
  eligible integer[] := '{}'; raw_evidence double precision[] := '{}'; rated_weight double precision[] := '{}';
  score_a double precision[] := '{}'; score_b double precision[] := '{}'; evidence double precision[] := '{}';
  event_no integer; actor integer; other integer; pair_idx integer; event_at double precision;
  present_idx integer[]; nc integer; quality double precision; unit double precision;
  previous_at double precision; score_sum double precision; inside boolean;
  scored boolean[] := '{}';
begin
  res.ev_pos := '{}'; res.ev_weight := '{}'; res.ev_full := '{}'; res.ev_sr := '{}';
  res.ev_uncertainty := '{}'; res.ev_expected := '{}'; res.ev_actual := '{}';
  if not (p_length > 0) then return res; end if;
  if target is null then raise exception 'invalid_rolling_evidence'; end if;
  -- Validate all histories, even those later excluded by activity/effort.
  for k in 1..n loop
    previous_at := -1; score_sum := 0;
    for event_no in 1..coalesce(cardinality(p_event_actor), 0) loop
      continue when p_event_actor[event_no] <> k;
      event_at := p_event_at[event_no];
      inside := false;
      for u in off + 1..off + p_iv_count[k] loop
        if p_iv_start[u] <= event_at and event_at <= p_iv_end[u] then inside := true; exit; end if;
      end loop;
      if event_at is null or event_at < previous_at or event_at < 0 or event_at > p_length or not inside
        or p_event_delta[event_no] is null or p_event_delta[event_no] not in (-1, 1) then
        raise exception 'invalid_score_event';
      end if;
      previous_at := event_at; score_sum := score_sum + p_event_delta[event_no];
      if score_sum < 0 then raise exception 'invalid_score_event'; end if;
      if p_event_delta[event_no] > 0 then scored[k] := true; end if;
    end loop;
    if score_sum <> p_kills[k] then raise exception 'incomplete_score_events'; end if;
    off := off + p_iv_count[k];
  end loop;
  off := 0;

  for k in 1..n loop
    c := p_iv_count[k];
    active := greatest(0::double precision, p_present[k] - p_afk[k]);
    if active < min_active or (not coalesce(scored[k], false) and p_shots[k] is not null and p_shots[k] < min_shots) then
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
    ne := ne + 1; eligible[k] := ne; raw_evidence[ne] := 0; rated_weight[ne] := 0;
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

  -- Observe each player's scoring against everybody present, not its victim.
  for event_no in 1..coalesce(cardinality(p_event_actor), 0) loop
    actor := eligible[p_event_actor[event_no]];
    continue when actor is null;
    event_at := p_event_at[event_no]; present_idx := '{}';
    for k in 1..ne loop
      for u in e_off[k]..e_off[k] + e_cnt[k] - 1 loop
        if iv_s[u] <= event_at and event_at <= iv_e[u] then
          present_idx := array_append(present_idx, k); exit;
        end if;
      end loop;
    end loop;
    quality := public._sr_lobby_size_weight(cardinality(present_idx), st);
    continue when quality = 0;
    unit := 1::double precision / (cardinality(present_idx) - 1);
    foreach other in array present_idx loop
      continue when other = actor;
      i := least(actor, other); j := greatest(actor, other); pair_idx := (i - 1) * ne + j;
      if actor = i then score_a[pair_idx] := coalesce(score_a[pair_idx], 0) + p_event_delta[event_no] * quality;
      else score_b[pair_idx] := coalesce(score_b[pair_idx], 0) + p_event_delta[event_no] * quality; end if;
      if p_event_delta[event_no] > 0 then
        evidence[pair_idx] := coalesce(evidence[pair_idx], 0) + quality * unit;
        raw_evidence[i] := raw_evidence[i] + unit / target;
        raw_evidence[j] := raw_evidence[j] + unit / target;
      end if;
    end loop;
  end loop;
  for i in 1..ne - 1 loop
    a_off := e_off[i]; a_cnt := e_cnt[i]; a_k := e_kills[i]; a_span := e_span[i]; a_w := e_w[i];
    a_sr := e_sr[i]; a_g := e_g[i];
    a1 := s1[i]; a2 := s2[i]; aw := sw[i]; aas := ss[i]; ae := se[i]; an := np[i];
    for j in i + 1..ne loop
      pair_idx := (i - 1) * ne + j;
      continue when coalesce(evidence[pair_idx], 0) = 0;
      ka := greatest(0::double precision, coalesce(score_a[pair_idx], 0));
      kb := greatest(0::double precision, coalesce(score_b[pair_idx], 0));
      continue when ka + kb <= 0;
      sh := case when logistic then 1 / (1 + exp(-(ka - kb) / logistic_scale)) else ka / (ka + kb) end;
      if wi = i then sh := sh + beta * (1 - sh);
      elsif wi = j then sh := 1 - ((1 - sh) + beta * sh);
      end if;
      pw := m * evidence[pair_idx] / target / greatest(1::double precision, raw_evidence[i], raw_evidence[j]);
      rated_weight[i] := rated_weight[i] + pw / m;
      rated_weight[j] := rated_weight[j] + pw / m;
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
    res.ev_weight[t] := rated_weight[i];
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

-- Flat profile events, merging rejoins but calculating deltas within each
-- session (each session's cumulative score starts at zero).
create function public._sr_score_event_rows(p_match uuid, p_names text[])
returns table(actor integer, at double precision, delta double precision)
language sql stable security definer set search_path = '' as $$
  select array_position(p_names, x.player_name), x.at, x.score - x.previous
  from (
    select m.player_name, s.session_no, e.ordinality,
      (e.value ->> 'at_s')::double precision as at,
      (e.value ->> 'score')::double precision as score,
      lag((e.value ->> 'score')::double precision, 1, 0::double precision)
        over (partition by s.id order by e.ordinality) as previous
    from public.player_sessions s join public.player_matches m on m.id = s.participation_id
    cross join lateral jsonb_array_elements(coalesce(s.score_events, '[]')) with ordinality e
    where m.match_id = p_match and m.player_name = any(p_names)
  ) x order by x.at, array_position(p_names, x.player_name), x.session_no, x.ordinality;
$$;

create function public._sr_rate_round_dispatch(p_params public.rating_params, p_match uuid, p_names text[],
  p_length double precision, p_winner integer,
  p_kills double precision[], p_present double precision[], p_afk double precision[], p_shots double precision[],
  p_iv_count integer[], p_iv_start double precision[], p_iv_end double precision[],
  p_sr double precision[], p_uncertainty double precision[])
returns public._sr_round_result language plpgsql stable security definer set search_path = '' as $$
declare actors integer[]; ats double precision[]; deltas double precision[];
begin
  if public._sr_rolling_target(p_params.settings) is null or not exists (
    select 1 from public.raw_logs where match_id = p_match and format_version = 3) then
    return public._sr_rate_round(p_params, p_length, p_winner, p_kills, p_present, p_afk, p_shots,
      p_iv_count, p_iv_start, p_iv_end, p_sr, p_uncertainty);
  end if;
  if exists (select 1 from unnest(p_names) name where not exists (
    select 1 from public.player_sessions s join public.player_matches m on m.id = s.participation_id
    where m.match_id = p_match and m.player_name = name and s.score_events is not null))
    or exists (select 1 from public.player_sessions s join public.player_matches m on m.id = s.participation_id
      where m.match_id = p_match and m.player_name = any(p_names) and s.score_events is null) then
    raise exception 'incomplete_score_events';
  end if;
  select coalesce(array_agg(actor), '{}'), coalesce(array_agg(at), '{}'), coalesce(array_agg(delta), '{}')
    into actors, ats, deltas from public._sr_score_event_rows(p_match, p_names);
  return public._sr_rate_event_round(p_params, p_length, p_winner, p_kills, p_present, p_afk, p_shots,
    p_iv_count, p_iv_start, p_iv_end, p_sr, p_uncertainty, actors, ats, deltas);
end;
$$;

alter function public._sr_rate_round_json(public.rating_params, jsonb, jsonb, jsonb) rename to _sr_time_round_json;
create or replace function public._sr_rate_round_json(p_params public.rating_params, p_round jsonb, p_states jsonb,
  p_seed jsonb default null)
returns jsonb language plpgsql immutable set search_path = '' set extra_float_digits = 3 as $$
declare
  names text[]; kills double precision[]; present double precision[]; afk double precision[];
  shots double precision[]; counts integer[]; starts double precision[]; ends double precision[];
  srs double precision[]; uncertainties double precision[]; winner integer;
  res public._sr_round_result;
  actors integer[]; ats double precision[]; deltas double precision[];
  seeded boolean := p_params.settings ->> 'start' = 'seed';
begin
  if public._sr_rolling_target(p_params.settings) is null or not exists (
    select 1 from jsonb_array_elements(p_round -> 'participants') p where p ? 'scoreEvents') then
    return public._sr_time_round_json(p_params, p_round, p_states, p_seed);
  end if;
  if exists (select 1 from jsonb_array_elements(p_round -> 'participants') p
    where jsonb_typeof(p -> 'scoreEvents') is distinct from 'array') then raise exception 'incomplete_score_events'; end if;
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
  select coalesce(array_agg(o::integer order by (e ->> 'at')::double precision, o, eo), '{}'),
    coalesce(array_agg((e ->> 'at')::double precision order by (e ->> 'at')::double precision, o, eo), '{}'),
    coalesce(array_agg((e ->> 'delta')::double precision order by (e ->> 'at')::double precision, o, eo), '{}')
    into actors, ats, deltas
  from jsonb_array_elements(p_round -> 'participants') with ordinality p(v,o),
    jsonb_array_elements(v -> 'scoreEvents') with ordinality events(e,eo);
  res := public._sr_rate_event_round(p_params, (p_round ->> 'length')::double precision, winner,
    kills, present, afk, shots, counts, starts, ends, srs, uncertainties, actors, ats, deltas);
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

-- Retain the established input assembly/order, extend its session-based
-- format detection to v3, and add exact events to the reference JSON shape.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public._sr_round_rows(timestamptz)'::regprocedure);
  if position('l.format_version = 2' in definition) = 0 then raise exception 'SR shape definition changed'; end if;
  execute replace(definition, 'l.format_version = 2', 'l.format_version in (2, 3)');
  definition := pg_get_functiondef('public.replay_ratings(timestamptz)'::regprocedure);
  if position('public._sr_rate_round(params, item.length' in definition) = 0 then raise exception 'SR replay definition changed'; end if;
  execute replace(definition, 'public._sr_rate_round(params, item.length',
    'public._sr_rate_round_dispatch(params, item.match_id, item.names, item.length');
end;
$$;

alter function public._sr_round_inputs(timestamptz) rename to _sr_time_round_inputs;
create function public._sr_round_inputs(p_from timestamptz default '-infinity')
returns table(match_id uuid, played_at timestamptz, round jsonb)
language sql stable security definer set search_path = '' set extra_float_digits = 3 as $$
  select r.match_id, r.played_at, case when l.format_version = 3 then r.round || jsonb_build_object('participants', (
    select jsonb_agg(p || jsonb_build_object('scoreEvents', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'delta', e.delta))
      from public._sr_score_event_rows(r.match_id, array(select value ->> 'name'
        from jsonb_array_elements(r.round -> 'participants'))) e where e.actor = o), '[]')) order by o)
    from jsonb_array_elements(r.round -> 'participants') with ordinality participants(p,o))) else r.round end
  from public._sr_time_round_inputs(p_from) r left join public.raw_logs l on l.match_id = r.match_id
  order by r.played_at, r.match_id::text collate "C";
$$;

create function public._sr_scores_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._sr_request_replay((select min(m.played_at) from public.player_matches m
    where m.id in (old.participation_id, new.participation_id) or m.match_id in (old.match_id, new.match_id)));
  return null;
end;
$$;
create trigger sr_score_history_updated after update of score_events on public.player_sessions
  for each row when (old.score_events is distinct from new.score_events) execute function public._sr_scores_changed();

revoke all on function public._sr_rolling_target(jsonb),
  public._sr_rate_event_round(public.rating_params, double precision, integer, double precision[], double precision[],
    double precision[], double precision[], integer[], double precision[], double precision[], double precision[], double precision[],
    integer[], double precision[], double precision[]),
  public._sr_rate_round_dispatch(public.rating_params, uuid, text[], double precision, integer, double precision[], double precision[],
    double precision[], double precision[], integer[], double precision[], double precision[], double precision[], double precision[]),
  public._sr_score_event_rows(uuid, text[]), public._sr_scores_changed(), public._sr_round_inputs(timestamptz),
  public._sr_rate_round_json(public.rating_params, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;

do $$
declare previous public.rating_params%rowtype;
begin
  select * into strict previous from public.rating_params where active;
  update public.rating_params set active = false where active;
  insert into public.rating_params(version,d,beta,settings,active,note)
  values(3,previous.d,previous.beta,previous.settings || '{"rollingEvidenceKills":50,"rollingMinShots":8}',true,
    'Rolling lobbies: exact shared scoring, size-discounted outcomes/evidence, symmetric per-round evidence cap');
end;
$$;
notify pgrst, 'reload schema';
commit;
