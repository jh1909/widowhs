-- Time-adjusted lobby-size weighting for hidden SR (PR #3).
-- Apply after 20261104120000_skill_rating.sql, staging before production.
-- No Workshop, Edge Function or UI deployment. Activates parameter version 2
-- and replays all stored history at commit under the existing import lock.
-- Exact curve anchors are versioned data; future retunes change rating_params,
-- not this migration. Keep the original applied migration unchanged.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

-- Same power curve as lobbySizeWeight in sr.ts. An absent lobbySize keeps
-- version 1's size-neutral algorithm available for comparisons and rollback.
create function public._sr_lobby_size_weight(p_players integer, p_settings jsonb)
returns double precision language plpgsql immutable set search_path = '' as $$
declare
  c jsonb := p_settings -> 'lobbySize';
  minimum double precision; full_players double precision;
  min_weight double precision; full_weight double precision;
  exponent double precision;
begin
  if c is null then return case when p_players < 2 then 0 else 1 end; end if;
  if pg_catalog.jsonb_typeof(c) is distinct from 'object'
    or pg_catalog.jsonb_typeof(c -> 'minPlayers') is distinct from 'number'
    or pg_catalog.jsonb_typeof(c -> 'fullPlayers') is distinct from 'number'
    or pg_catalog.jsonb_typeof(c -> 'minWeight') is distinct from 'number'
    or pg_catalog.jsonb_typeof(c -> 'fullWeight') is distinct from 'number' then
    raise exception 'invalid_lobby_size';
  end if;
  minimum := (c ->> 'minPlayers')::double precision;
  full_players := (c ->> 'fullPlayers')::double precision;
  min_weight := (c ->> 'minWeight')::double precision;
  full_weight := (c ->> 'fullWeight')::double precision;
  if minimum < 2 or minimum <> trunc(minimum) or full_players <> trunc(full_players)
    or full_players <= minimum or min_weight <= 0 or min_weight > full_weight or full_weight > 1 then
    raise exception 'invalid_lobby_size';
  end if;
  if p_players < minimum then return 0; end if;
  if p_players >= full_players then return full_weight; end if;
  exponent := ln(min_weight / full_weight) / ln((minimum - 1) / (full_players - 1));
  return full_weight * power((p_players - 1) / (full_players - 1), exponent);
end;
$$;

create function public._sr_validate_lobby_size()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform public._sr_lobby_size_weight(2, new.settings);
  return new;
end;
$$;
create trigger sr_validate_lobby_size before insert or update on public.rating_params
  for each row execute function public._sr_validate_lobby_size();

create or replace function public._sr_rate_round(p_params public.rating_params, p_length double precision, p_winner integer,
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
  sized boolean := st ? 'lobbySize';
  bounds double precision[]; segment integer; present_idx integer[]; nc integer;
  size_weight double precision; duration double precision; pa integer; pb integer;
  pair_w double precision[] := '{}'; e_rw double precision[] := '{}';
begin
  res.ev_pos := '{}'; res.ev_weight := '{}'; res.ev_full := '{}'; res.ev_sr := '{}';
  res.ev_uncertainty := '{}'; res.ev_expected := '{}'; res.ev_actual := '{}';
  perform public._sr_lobby_size_weight(2, st);
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
  if sized then
    -- The same session boundaries, iteration order and sums as sr.ts.
    select array_agg(v order by v) into bounds from (
      select distinct v from unnest(array[0::double precision, p_length] || iv_s || iv_e) v
      where v >= 0 and v <= p_length
    ) times;
    for segment in 2..cardinality(bounds) loop
      present_idx := '{}';
      for k in 1..ne loop
        for u in e_off[k]..e_off[k] + e_cnt[k] - 1 loop
          if iv_s[u] <= bounds[segment - 1] and iv_e[u] >= bounds[segment] then
            present_idx := array_append(present_idx, k);
            exit;
          end if;
        end loop;
      end loop;
      nc := cardinality(present_idx);
      size_weight := public._sr_lobby_size_weight(nc, st);
      continue when size_weight = 0;
      duration := (bounds[segment] - bounds[segment - 1]) / p_length;
      foreach k in array present_idx loop
        e_rw[k] := coalesce(e_rw[k], 0) + duration * size_weight;
      end loop;
      for pa in 1..nc - 1 loop
        for pb in pa + 1..nc loop
          k := (present_idx[pa] - 1) * ne + present_idx[pb];
          pair_w[k] := coalesce(pair_w[k], 0) + duration * m * size_weight / (nc - 1);
        end loop;
      end loop;
    end loop;
  end if;
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
      -- AFK has a duration but no timeline: retain the existing active-time
      -- cap, spread uniformly over this pair's shared periods.
      pw := case when sized then coalesce(pair_w[(i - 1) * ne + j], 0)
          * least(1::double precision, e_active[i] / shared, e_active[j] / shared)
        else least(shared / p_length, a_w, e_w[j]) * scale end;
      continue when pw <= 0;
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
    res.ev_weight[t] := case when sized then coalesce(e_rw[i], 0)
      * least(1::double precision, e_active[i] / e_span[i]) else e_w[i] end;
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

revoke all on function public._sr_lobby_size_weight(integer, jsonb), public._sr_validate_lobby_size()
  from public, anon, authenticated, service_role;

-- Existing hooks coalesce the deactivation and activation into one replay.
-- Copy the active settings so other tuning is retained.
do $$
declare previous public.rating_params%rowtype;
begin
  select * into strict previous from public.rating_params where active;
  update public.rating_params set active = false where active;
  insert into public.rating_params(version, d, beta, settings, active, note)
  values (2, previous.d, previous.beta, previous.settings ||
    '{"lobbySize":{"minPlayers":2,"minWeight":0.05,"fullPlayers":8,"fullWeight":1}}',
    true, 'Concurrent lobby size: smooth power curve from 5% at two players to full weight at eight');
end;
$$;
notify pgrst, 'reload schema';
commit;
