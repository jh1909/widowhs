import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '00000000-0000-0000-0000-000000000001';
const bob = '00000000-0000-0000-0000-000000000002';
const admin = '00000000-0000-0000-0000-000000000003';
const latest = '20261013200000_profile_bio_and_setup.sql';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('personal profile content respects ownership and survives account/statistics changes', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${alice}'),('${bob}'),('${admin}');
      create table auth.identities(user_id uuid,provider text);
      insert into auth.identities values ('${alice}','discord'),('${bob}','discord'),('${admin}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts jsonb default '[]',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values
        ('Alice','${alice}',false,0,'-'),('Bob','${bob}',false,0,'-'),('Admin','${admin}',true,0,'-'),('Imported',null,false,0,'-');
    `);
    for (const name of ['20261005210000_admin_leaderboard_reset.sql', '20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql', '20261012130000_count_imported_rounds.sql', '20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql', '20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql', '20261013180000_pb_rankings_and_records.sql', latest])
      await db.exec(await migration(name));

    const asRole = async <T>(role: string, uid: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec('reset role'); }
    };
    const read = async (name: string) => (await asRole('anon', '', () => db.query<{result: any}>(
      'select public.get_player_profile_details($1) as result', [name]))).rows[0].result;
    const save = async (uid: string, name: string, bio: string | null, setup: unknown = {}) =>
      (await asRole('authenticated', uid, () => db.query<{result: any}>(
        'select public.update_player_profile_details($1,$2,$3) as result', [name, bio, JSON.stringify(setup)]))).rows[0].result;
    const denied = (promise: Promise<unknown>) => assert.rejects(promise, (error: any) => error.code === '42501');

    await t.test('imported/empty profiles return no personal content and the public projection contains no IDs', async () => {
      assert.deepEqual(await read('Imported'), {bio: '', setup: {}});
      assert.equal(await read('Missing'), null);
      assert.deepEqual(await save(alice, 'Alice', ' Hello\nworld! ', {mouse: ' Example Mouse ', dpi: '800', sensitivity: '4.5', settings: ' ', crosshair: '<script>literal text</script>'}),
        {bio: 'Hello\nworld!', setup: {mouse: 'Example Mouse', dpi: '800', sensitivity: '4.5', crosshair: '<script>literal text</script>'}});
      assert.deepEqual(Object.keys(await read('Alice')).sort(), ['bio', 'setup']);
    });

    await t.test('foreign users, admins and guests cannot edit another owner or an imported profile', async () => {
      const before = await read('Alice');
      await denied(save(bob, 'Alice', 'Stolen'));
      await denied(save(admin, 'Alice', 'Admin override'));
      await denied(save(alice, 'Imported', 'Claim without linking'));
      await denied(save('', 'Alice', 'No session'));
      await denied(asRole('anon', '', () => db.query("select public.update_player_profile_details('Alice','Guest','{}')")));
      assert.deepEqual(await read('Alice'), before);
    });

    await t.test('the raw table is private and browser writes cannot bypass validation or ownership', async () => {
      for (const role of ['anon', 'authenticated']) {
        await denied(asRole(role, bob, () => db.query('select * from public.player_profile_details')));
        await denied(asRole(role, bob, () => db.query('update public.player_profile_details set bio=$1 where user_id=$2', ['Changed', alice])));
        await denied(asRole(role, bob, () => db.query('insert into public.player_profile_details(user_id,bio) values($1,$2)', [bob, 'Bypass'])));
      }
    });

    await t.test('length limits, object shape and allowed text fields are validated transactionally', async () => {
      const before = await read('Alice');
      for (const [bio, setup] of [['x'.repeat(501), {}], ['', []], ['', 'string'], ['', {unknown: 'x'}],
        ['', {mouse: 123}], ['', {mouse: null}], ['', {mouse: 'x'.repeat(121)}], ['', {crosshair: 'x'.repeat(501)}], ['', {settings: 'x'.repeat(1001)}]] as const) {
        await assert.rejects(save(alice, 'Alice', bio, setup), (error: any) => error.code === '22023');
        assert.deepEqual(await read('Alice'), before);
      }
      await save(bob, 'Bob', '🙂'.repeat(500), {settings: 'x'.repeat(1000)});
      assert.equal((await read('Bob')).setup.settings.length, 1000);
    });

    await t.test('a nickname rename keeps content and makes it available at the new profile', async () => {
      const before = await read('Alice');
      await asRole('authenticated', alice, () => db.query("select public.rename_player('Alice','Renamed')"));
      assert.equal(await read('Alice'), null);
      assert.deepEqual(await read('Renamed'), before);
    });

    await t.test('OAuth imports and same-owner merges preserve personal content', async () => {
      const before = await read('Renamed');
      await db.query("update public.players set matches=1 where name='Renamed'");
      await db.query('insert into public.players(name,user_id,matches,elo,bnet_accounts) values($1,$2,0,$3,$4)', ['Duplicate', alice, '-', '["Imported"]']);
      await asRole('service_role', '', () => db.query('select public.complete_battlenet_account_link($1,$2,$3)', [alice, '100', 'Imported#12345']));
      assert.deepEqual(await read('Renamed'), before);
      assert.equal(await read('Imported'), null);
      assert.equal(await read('Duplicate'), null);
      assert.equal(Number((await db.query<any>('select count(*) as n from public.player_profile_details where user_id=$1', [alice])).rows[0].n), 1);
    });

    await t.test('a verified name takeover keeps each Discord owner’s bio and equipment separate', async () => {
      await db.query("select public._link_bnet_account_impl($1,'Bob','ManualName',false)", [bob]);
      const aliceBefore = await read('Renamed');
      const bobBefore = await read('Bob');
      await asRole('service_role', '', () => db.query('select public.complete_battlenet_account_link($1,$2,$3)', [alice, '101', 'ManualName#12345']));
      assert.deepEqual(await read('Renamed'), aliceBefore);
      assert.deepEqual(await read('Bob'), bobBefore);
    });

    await t.test('stats resets and migration reinstallation preserve content', async () => {
      const before = await read('Renamed');
      await asRole('authenticated', admin, () => db.query("select public.reset_leaderboard('RESET')"));
      await db.exec(await migration(latest));
      assert.deepEqual(await read('Renamed'), before);
    });

    await t.test('owners can clear all content, and deleting the last profile removes its content', async () => {
      assert.deepEqual(await save(bob, 'Bob', null, {mouse: '   ', settings: ''}), {bio: '', setup: {}});
      await db.query('delete from public.players where user_id=$1', [alice]);
      assert.equal(Number((await db.query<any>('select count(*) as n from public.player_profile_details where user_id=$1', [alice])).rows[0].n), 0);
      await save(bob, 'Bob', 'Delete with Auth');
      await db.query('delete from auth.users where id=$1', [bob]);
      assert.deepEqual(await read('Bob'), {bio: '', setup: {}});
    });
  } finally { await db.close(); }
});
