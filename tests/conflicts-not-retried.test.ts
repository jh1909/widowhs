import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// 20261103130000_conflicts_not_retried: PostgREST retries SQLSTATE 40001 by
// itself, so conflicts a retry can't clear must use PT409 (HTTP 409).
const target = '20261103130000_conflicts_not_retried.sql';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const functions = ['apply_match_import', 'rename_player', 'admin_moderate_player',
  'update_player_profile_details', '_release_unverified_bnet_name'];

test('conflicts use PT409, which PostgREST does not retry', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      create table auth.identities(user_id uuid,provider text);
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts jsonb default '[]',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
        performance_score integer,created_at timestamptz default now());
      create table public.player_history(id uuid default gen_random_uuid() primary key,
        player_name text,elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
    `);
    const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort();
    assert.ok(names.includes(target));
    for (const name of names.filter(name => name < target)) await db.exec(await migration(name));

    const definitions = async () => (await db.query<{ name: string; def: string; acl: string; owner: string }>(`
      select p.proname as name, pg_get_functiondef(p.oid) as def, p.proacl::text as acl, p.proowner::regrole::text as owner
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by 1`, [functions])).rows;
    const before = await definitions();
    assert.equal(before.length, functions.length);
    await db.exec(await migration(target));
    const afterTarget = await definitions();
    for (const name of names.filter(name => name > target)) await db.exec(await migration(name));

    await t.test('each function changes only its error code', async () => {
      assert.deepEqual(afterTarget, before.map(f => ({
        ...f, def: f.def.replaceAll("errcode = '40001'", "errcode = 'PT409'") })));
    });

    await t.test('no function raises 40001 any more', async () => {
      const left = (await db.query<{ proname: string }>(`select proname from pg_proc
        where pronamespace = 'public'::regnamespace and prosrc like '%''40001''%'`)).rows;
      assert.deepEqual(left, []);
    });

    await t.test('a stale import is rejected with PT409 and writes nothing', async () => {
      const revision = (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
      await db.exec('set role service_role');
      try {
        await assert.rejects(db.query("select public.apply_match_import($1,'[]','[]','[]','[]','TEST','stale')",
          [Number(revision) - 1]), (error: any) => error.code === 'PT409'
            && error.message === 'Leaderboard changed during upload. Please import the files again.');
      } finally {
        await db.exec('reset role');
      }
      assert.equal((await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision, revision);
    });

    await t.test('a missing profile is rejected with PT409', async () => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", ['00000000-0000-0000-0000-000000000001']);
      await db.exec('set role authenticated');
      try {
        await assert.rejects(db.query("select public.rename_player('Missing', 'Other')"),
          (error: any) => error.code === 'PT409');
      } finally {
        await db.exec('reset role');
      }
    });
  } finally {
    await db.close();
  }
});
