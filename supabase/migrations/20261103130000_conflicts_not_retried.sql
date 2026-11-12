-- Conflicts the caller has to resolve use SQLSTATE PT409, not 40001.
--
-- PostgREST retries a request whose transaction fails with 40001
-- (serialization_failure) by itself, inside the same request. These functions
-- raise 40001 for conflicts that a retry of the same request can never clear:
-- a stale leaderboard revision, a file another upload stored meanwhile, a
-- profile that no longer exists. Such a request looped until the gateway gave
-- up. PT409 is never retried and reaches the client as HTTP 409, with the same
-- message; upload-csv retries it itself, after reading a fresh revision.
--
-- Each function is recreated from its current definition with only the error
-- code changed, so owner, grants and everything else stay as they are.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);

do $$
declare
  f regprocedure;
  def text;
  rewritten integer := 0;
begin
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('apply_match_import', 'rename_player', 'admin_moderate_player',
        'update_player_profile_details', '_release_unverified_bnet_name')
  loop
    def := pg_catalog.pg_get_functiondef(f);
    if pg_catalog.strpos(def, 'errcode = ''40001''') = 0 then
      raise exception '% no longer raises 40001; review this migration', f;
    end if;
    execute pg_catalog.replace(def, 'errcode = ''40001''', 'errcode = ''PT409''');
    rewritten := rewritten + 1;
  end loop;
  if rewritten <> 5 then
    raise exception 'Expected 5 functions to rewrite, found %', rewritten;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
