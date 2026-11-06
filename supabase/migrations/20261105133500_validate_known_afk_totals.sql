-- PR #2: known AFK intervals require known bounds and total. Legacy NULL
-- intervals retain their unknown semantics. Apply after the v4 completeness
-- migration, staging before production; function permissions are unchanged.
begin;
select pg_catalog.pg_advisory_xact_lock(1909, 1);
do $$
declare definition text := pg_get_functiondef('public._valid_afk_intervals(jsonb,numeric,numeric,numeric)'::regprocedure);
  anchor text := 'if periods is null then return true; end if;';
begin
  if position(anchor in definition) = 0 then raise exception 'AFK validation definition changed'; end if;
  execute replace(definition, anchor, anchor || E'\n  if started is null or ended is null or total is null then return false; end if;');
end;
$$;
commit;
