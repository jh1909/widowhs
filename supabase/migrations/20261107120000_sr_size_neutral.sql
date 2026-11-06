-- PR #3: SR no longer discounts small lobbies. Staging before production.
-- Activates parameter version 4: version 3's settings with a flat lobby-size
-- curve (full weight from two players), and replays history. The curve code and
-- versions 1-3 remain; reactivate version 3 or add a version to restore it.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

-- Existing hooks coalesce the deactivation and activation into one replay.
-- Copy the active settings so other tuning is retained.
do $$
declare previous public.rating_params%rowtype;
begin
  select * into strict previous from public.rating_params where active;
  update public.rating_params set active = false where active;
  insert into public.rating_params(version, d, beta, settings, active, note)
  values (4, previous.d, previous.beta, previous.settings ||
    '{"lobbySize":{"minPlayers":2,"minWeight":1,"fullPlayers":8,"fullWeight":1}}',
    true, 'Size-neutral: every lobby of two or more players at full weight; the curve stays configurable');
end;
$$;
notify pgrst, 'reload schema';
commit;
