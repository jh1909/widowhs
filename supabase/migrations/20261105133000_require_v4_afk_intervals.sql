-- PR #2: enforce known AFK timing for v4 independently of SR installation.
-- Apply after afk_intervals, on staging then production, before upload-csv
-- and Workshop v3.7.0. Deferred checks permit atomic imports/corrections in
-- either order, but no committed v4 session can retain legacy unknown timing.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

create function public._require_v4_afk_intervals()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected uuid[]; participations bigint[];
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  -- All three tables have match_id. Sessions additionally point to the
  -- participation whose round SR follows, which may differ after a correction.
  affected := array[(to_jsonb(new) ->> 'match_id')::uuid];
  if tg_op = 'UPDATE' then affected := array_append(affected,(to_jsonb(old) ->> 'match_id')::uuid); end if;
  if tg_table_name = 'player_sessions' then
    participations := array[new.participation_id];
    if tg_op = 'UPDATE' then participations := array_append(participations,old.participation_id); end if;
    select affected || coalesce(array_agg(m.match_id),'{}') into affected
      from public.player_matches m where m.id = any(participations);
  end if;
  if exists (
    select 1 from public.player_sessions s
    left join public.player_matches m on m.id = s.participation_id
    where s.afk_intervals is null
      and (s.match_id = any(affected) or m.match_id = any(affected))
      and exists (select 1 from public.raw_logs l where l.format_version = 4
        and l.match_id in (s.match_id,m.match_id))
  ) then
    raise exception 'v4 sessions require known AFK intervals' using errcode = '23514';
  end if;
  return null;
end;
$$;
revoke all on function public._require_v4_afk_intervals() from public,anon,authenticated,service_role;

create constraint trigger require_v4_session_afk after insert or update on public.player_sessions
  deferrable initially deferred for each row execute function public._require_v4_afk_intervals();
create constraint trigger require_v4_participation_afk after insert or update on public.player_matches
  deferrable initially deferred for each row execute function public._require_v4_afk_intervals();
create constraint trigger require_v4_log_afk after insert or update on public.raw_logs
  deferrable initially deferred for each row execute function public._require_v4_afk_intervals();

-- Reject an already inconsistent installation before it can break SR replay.
do $$
begin
  if exists (select 1 from public.player_sessions s left join public.player_matches m on m.id=s.participation_id
    where s.afk_intervals is null and exists (select 1 from public.raw_logs l
      where l.format_version=4 and l.match_id in (s.match_id,m.match_id))) then
    raise exception 'v4 sessions require known AFK intervals' using errcode='23514';
  end if;
end;
$$;
commit;
