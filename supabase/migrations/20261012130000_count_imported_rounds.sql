-- One round per imported file, shared by every tracked player in that file.
-- Existing records can only be grouped by their stored match/upload timestamp.
begin;
do $$ begin perform pg_catalog.pg_advisory_xact_lock(1909, 1); end $$;
lock table public.players, public.player_history, public.player_matches in share row exclusive mode;

alter table public.player_matches add column if not exists match_id uuid;
with legacy_rounds as (
  select played_at, pg_catalog.gen_random_uuid() as match_id
  from public.player_matches where match_id is null group by played_at
)
update public.player_matches as matches set match_id = legacy_rounds.match_id
from legacy_rounds where matches.match_id is null and matches.played_at = legacy_rounds.played_at;
alter table public.player_matches alter column match_id set default pg_catalog.gen_random_uuid();
alter table public.player_matches alter column match_id set not null;
comment on column public.player_matches.match_id is
  'Round ID shared by player records from one uploaded file; legacy records grouped by played_at.';
create index if not exists player_matches_match_id_idx on public.player_matches (match_id);

create or replace function public.apply_match_import(
  p_expected_revision bigint, p_players jsonb, p_ranks jsonb,
  p_history jsonb, p_matches jsonb, p_admin_user text, p_details text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision bigint;
  imported_player public.players%rowtype;
  imported_match public.player_matches%rowtype;
  match_payload jsonb;
  legacy_match_id uuid := pg_catalog.gen_random_uuid();
  history_entry public.player_history%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(1909, 1);
  lock table public.players, public.player_history, public.player_matches in share row exclusive mode;
  select revision into current_revision from public.leaderboard_state where singleton for update;
  if current_revision is null or current_revision is distinct from p_expected_revision then
    raise exception 'Leaderboard changed during upload. Please import the files again.' using errcode = '40001';
  end if;

  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_players)
  loop
    update public.players set matches = imported_player.matches, score = imported_player.score,
      deaths = imported_player.deaths, kdr = imported_player.kdr, accuracy = imported_player.accuracy,
      kpm = imported_player.kpm, crouches = imported_player.crouches,
      time_in_lobby = imported_player.time_in_lobby, elo = imported_player.elo,
      rank = imported_player.rank, tag = imported_player.tag
    where name = imported_player.name;
    if not found then
      raise exception 'Player changed during upload. Please import the files again.' using errcode = '40001';
    end if;
  end loop;
  for imported_player in select * from pg_catalog.jsonb_populate_recordset(null::public.players, p_ranks)
  loop
    update public.players set rank = imported_player.rank where name = imported_player.name;
  end loop;

  for history_entry in select * from pg_catalog.jsonb_populate_recordset(null::public.player_history, p_history)
  loop
    insert into public.player_history (player_name, elo, rank)
      values (history_entry.player_name, history_entry.elo, history_entry.rank);
  end loop;
  for match_payload in select value from pg_catalog.jsonb_array_elements(p_matches)
  loop
    imported_match := pg_catalog.jsonb_populate_record(null::public.player_matches, match_payload);
    insert into public.player_matches (player_name, score, deaths, accuracy, kpm, kdr,
      crouches, time_in_lobby, total_match_time, performance_score, played_at, match_id)
    values (imported_match.player_name, imported_match.score, imported_match.deaths,
      imported_match.accuracy, imported_match.kpm, imported_match.kdr, imported_match.crouches,
      imported_match.time_in_lobby, imported_match.total_match_time, imported_match.performance_score,
      coalesce((match_payload ->> 'played_at')::timestamp at time zone 'Europe/Berlin', pg_catalog.now()),
      coalesce(imported_match.match_id, legacy_match_id));
  end loop;
  insert into public.audit_logs (action, admin_user, details)
    values ('EDGE_FUNCTION_CSV_UPLOAD', p_admin_user, p_details);
  update public.leaderboard_state set revision = revision + 1 where singleton;
end;
$$;
revoke all on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_match_import(bigint, jsonb, jsonb, jsonb, jsonb, text, text)
  to service_role;

-- Public aggregate only: no player details are returned by this function.
create or replace function public.get_match_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$ select count(distinct match_id) from public.player_matches $$;
revoke all on function public.get_match_count() from public;
grant execute on function public.get_match_count() to anon, authenticated, service_role;

update public.leaderboard_state set revision = revision + 1 where singleton;
notify pgrst, 'reload schema';
commit;
select 'Round counter installed' as status;
