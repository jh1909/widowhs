import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '00000000-0000-0000-0000-000000000001';
const bob = '00000000-0000-0000-0000-000000000002';
const admin = '00000000-0000-0000-0000-000000000003';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('primary regions respect ownership and rank the full regional population before paging', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${alice}'),('${bob}'),('${admin}');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts jsonb default '[]',matches integer default 10,score integer default 100,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text,
        avatar_url text,is_verified boolean default false,is_banned boolean default false,
        placement_matches integer default 10,personal_best_time numeric,
        recent_matches integer,recent_kdr numeric,recent_accuracy numeric,recent_kpm numeric,
        recent_crouches integer,recent_time_in_lobby numeric);
      create table public.player_matches(match_id uuid);
      create table public.battlenet_oauth_requests(user_id uuid);
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,elo,personal_best_time) values
        ('Alice','${alice}',false,'1,500',100),('Bob','${bob}',false,'1,600',120),
        ('Admin','${admin}',true,'-',null),('Unset',null,false,'1,700',90);
    `);
    for (const name of ['20261013200000_profile_bio_and_setup.sql',
      '20261013220000_admin_profile_details_moderation.sql',
      '20261101182500_server_side_leaderboard_and_profile.sql', '20261106120000_primary_regions.sql'])
      await db.exec(await migration(name));

    const asRole = async <T>(role: string, uid: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec('reset role'); }
    };
    const read = async (name: string) => (await asRole('anon', '', () => db.query<any>(
      'select public.get_player_profile_details($1) as result', [name]))).rows[0].result;
    const save = async (uid: string, name: string, region: unknown, bio = '', setup = {}) =>
      (await asRole('authenticated', uid, () => db.query<any>(
        'select public.update_player_profile_details($1,$2,$3,$4) as result',
        [name, bio, JSON.stringify(setup), region]))).rows[0].result;
    const page = async (region: string | null, search = '', limit = 10, offset = 0) =>
      (await asRole('anon', '', () => db.query<any>(
        'select public.get_leaderboard_page($1,$2,$3,$4) as result', [search, limit, offset, region]))).rows[0].result;
    const denied = (promise: Promise<unknown>) => assert.rejects(promise, (error: any) => error.code === '42501');

    await t.test('unset profiles remain global, and owners can select, switch or clear their region', async () => {
      assert.deepEqual(await read('Alice'), {bio: '', setup: {}, primary_region: null});
      assert.equal(await read('Missing'), null);
      const stats = (await db.query('select * from public.players order by name')).rows;
      await save(alice, 'Alice', 'eu', 'Hello', {mouse:'Mouse'});
      assert.deepEqual(await read('Alice'), {bio:'Hello', setup:{mouse:'Mouse'}, primary_region:'eu'});
      assert.equal((await page('eu')).players[0].name, 'Alice');
      assert.equal((await page('na')).players.length, 0);
      await save(alice, 'Alice', 'na');
      assert.equal((await page('eu')).players.length, 0);
      assert.equal((await page('na')).players[0].name, 'Alice');
      await save(alice, 'Alice', null);
      assert.equal((await page('na')).players.length, 0);
      assert.equal((await page(null)).players.length, 3);
      assert.deepEqual((await db.query('select * from public.players order by name')).rows, stats);
    });

    await t.test('guests, other owners and raw table writes cannot assign regions', async () => {
      await denied(save(bob, 'Alice', 'eu'));
      await denied(save('', 'Alice', 'eu'));
      await denied(save(alice, 'Unset', 'eu'));
      await denied(asRole('anon', '', () => db.query("select public.update_player_profile_details('Alice','','{}','eu')")));
      for (const role of ['anon', 'authenticated']) {
        await denied(asRole(role, alice, () => db.query("update public.player_profile_details set primary_region='eu'")));
        await denied(asRole(role, alice, () => db.query('select * from public.player_profile_details')));
      }
      assert.equal((await read('Alice')).primary_region, null);
    });

    await t.test('invalid region or invalid profile fields roll back the entire save', async () => {
      const before = await read('Alice');
      for (const region of ['EU', 'asia', '', 'all']) {
        await assert.rejects(save(alice, 'Alice', region, 'Should roll back'), (e:any) => e.code === '22023');
        assert.deepEqual(await read('Alice'), before);
      }
      await assert.rejects(save(alice, 'Alice', 'eu', 'x'.repeat(501)), (e:any) => e.code === '22023');
      assert.deepEqual(await read('Alice'), before);
    });

    await t.test('admins edit the target preference with audit and revoked admins cannot', async () => {
      await save(admin, 'Alice', 'eu');
      assert.equal((await read('Alice')).primary_region, 'eu');
      assert.equal((await read('Admin')).primary_region, null);
      assert.equal((await db.query<any>("select count(*)::integer as n from public.audit_logs where action='MODERATE_PRIMARY_REGION'")).rows[0].n, 1);
      await db.exec("update public.players set is_admin=false where name='Admin'");
      await denied(save(admin, 'Alice', 'na'));
      await db.exec("update public.players set is_admin=true where name='Admin'");
    });

    await t.test('old profile saves preserve region and old leaderboard callers stay global', async () => {
      await asRole('authenticated', alice, () => db.query("select public.update_player_profile_details('Alice','Old browser','{}')"));
      assert.equal((await read('Alice')).primary_region, 'eu');
      const old = (await asRole('anon', '', () => db.query<any>('select public.get_leaderboard_page() as result'))).rows[0].result;
      assert.deepEqual(old, await page(null));
    });

    await t.test('regional ranks precede search/paging and preserve separate global ranks and metrics', async () => {
      await save(bob, 'Bob', 'na');
      // More than one page of EU players: filtering the global page would miss these.
      for (let i = 0; i < 13; i++) {
        const uid = `10000000-0000-0000-0000-${String(i).padStart(12,'0')}`;
        await db.query('insert into auth.users values ($1)', [uid]);
        await db.query("insert into public.players(name,user_id,elo,bnet_accounts) values ($1,$2,$3,$4)",
          [`EU${i}`, uid, String(1400-i), JSON.stringify([`Account${i}`])]);
        await db.query("insert into public.player_profile_details(user_id,primary_region) values ($1,'eu')", [uid]);
      }
      const global = await page(null);
      const eu = await page('eu', '', 10, 10);
      assert.deepEqual(eu.players.map((p:any) => p.rank), [11,12,13,14]);
      assert.deepEqual(eu.players.map((p:any) => p.global_rank), [13,14,15,16]);
      assert.equal(eu.filtered_count, 14);
      for (const key of ['ranked_players','total_kills','total_matches','record_holder'])
        assert.deepEqual(eu[key], global[key], key);
      const searched = await page('eu', 'Account12');
      assert.equal(searched.players[0].rank, 14);
      assert.equal(searched.players[0].name, 'EU12');
      assert.equal((await page('eu', 'Bob')).filtered_count, 0);
      assert.equal((await page('na')).players[0].rank, 1);
      assert.equal((await page('na')).players[0].global_rank, 2);
      assert.equal((await page('invalid')).filtered_count, 0);
    });

    await t.test('bans/placements apply to regional views and preferences survive renames and stats changes', async () => {
      await db.exec("update public.players set is_banned=true where name='Alice'");
      assert.equal((await page('eu')).players[0].name, 'EU0');
      await db.exec("update public.players set is_banned=false,placement_matches=9 where name='Alice'");
      assert.equal((await page('eu')).players[0].name, 'EU0');
      await db.exec("update public.players set name='Renamed',placement_matches=10 where name='Alice'");
      assert.equal((await read('Renamed')).primary_region, 'eu');
      assert.equal((await page('eu')).players[0].name, 'Renamed');
      await db.exec("update public.players set elo='-',matches=0,placement_matches=0 where name='Renamed'");
      assert.equal((await read('Renamed')).primary_region, 'eu');
      await db.exec("delete from public.players where name='Renamed'");
      assert.equal((await db.query<any>('select count(*)::integer as n from public.player_profile_details where user_id=$1',[alice])).rows[0].n, 0);
    });
  } finally { await db.close(); }
});
