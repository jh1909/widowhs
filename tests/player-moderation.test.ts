import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { confirmPlayerModeration } from '../src/lib/player-moderation.ts';
import { rankPlayers, recordHolder } from '../supabase/functions/_shared/leaderboard.ts';
import { statMedals } from '../src/lib/stat-medals.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { assignMatchId } from '../supabase/functions/_shared/match-upload.ts';

const alice = '00000000-0000-0000-0000-000000000001';
const bob = '00000000-0000-0000-0000-000000000002';
const admin = '00000000-0000-0000-0000-000000000003';
const latest = '20261015120000_admin_player_moderation.sql';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('the UI requires explicit confirmation, including the expected target, action and resulting state', () => {
  for (const action of ['ban', 'unban', 'delete'] as const) {
    const reply = {name:'Alice', action, deleted:action === 'delete', is_banned:action === 'ban'};
    confirmPlayerModeration(reply, null, 'Alice', action);
    for (const data of [null, [], {}, {...reply,name:'Bob'}, {...reply,deleted:!reply.deleted}])
      assert.throws(() => confirmPlayerModeration(data, null, 'Alice', action), /did not confirm/);
    if (action !== 'delete') assert.throws(() => confirmPlayerModeration({...reply,is_banned:!reply.is_banned}, null, 'Alice', action));
  }
  assert.throws(() => confirmPlayerModeration(null, {message:'Denied',code:'42501'}, 'Alice', 'ban'), /Denied/);
  assert.throws(() => confirmPlayerModeration(null, {message:'Missing',code:'PGRST202'}, 'Alice', 'ban'), /20261015120000/);
});

test('admin moderation works with restrictive RLS and existing import/history triggers', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values('${alice}'),('${bob}'),('${admin}');
      create table auth.identities(user_id uuid,provider text);
      insert into auth.identities values('${alice}','discord'),('${bob}','discord'),('${admin}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,is_banned boolean default false,
        bnet_accounts jsonb default '[]',matches integer,score integer,deaths integer,kdr text,accuracy text,kpm text,
        crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values
        ('Alice','${alice}',false,10,'1000'),('Bob','${bob}',false,10,'900'),('Admin','${admin}',true,0,'-');
      alter table public.players enable row level security;
      create policy read_players on public.players for select using(true);
      create policy own_update on public.players for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update,delete on public.players to anon,authenticated;
    `);
    for (const name of ['20261005210000_admin_leaderboard_reset.sql','20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql','20261012130000_count_imported_rounds.sql','20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql','20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql','20261013180000_pb_rankings_and_records.sql',
      '20261013200000_profile_bio_and_setup.sql','20261013210000_public_elo_history.sql',
      '20261013220000_admin_profile_details_moderation.sql','20261013230000_daily_average_elo_history.sql',
      '20261013233000_weighted_elo_participation.sql','20261014010000_count_fully_eligible_placements.sql',latest])
      await db.exec(await migration(name));
    const asRole = async <T>(role: string, uid: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
      await db.exec(`set role ${role}`); try { return await action(); } finally { await db.exec('reset role'); }
    };
    const moderate = async (name: string, action: string | null, actor=admin) =>
      (await asRole('authenticated',actor,() => db.query<any>('select public.admin_moderate_player($1,$2) result',[name,action]))).rows[0].result;
    const players = async () => (await db.query<any>('select * from public.players order by name')).rows;
    const snapshot = async () => JSON.stringify(await Promise.all(['players','player_matches','player_history','audit_logs','leaderboard_state',
      'player_elo_legacy','player_profile_details','battlenet_account_links','battlenet_oauth_requests'].map(table => db.query(`select * from public.${table} order by 1`))));
    const match = (name: string) => assignMatchId([{player_name:name,score:50,deaths:10,accuracy:60,kpm:15,kdr:5,crouches:100,
      time_in_lobby:200,total_match_time:200,played_at:'2026-10-15T12:00:00'}]);
    const importMatch = async (name: string) => {
      const payload = buildMatchImport(await players() as ImportPlayer[], match(name));
      const revision = (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
      await asRole('service_role','',() => db.query('select public.apply_match_import($1,$2,$3,$4,$5,$6,$7)',
        [revision,JSON.stringify(payload.players),JSON.stringify(payload.ranks),JSON.stringify(payload.history),JSON.stringify(payload.matches),'TEST','Test upload']));
    };
    await importMatch('Alice'); await importMatch('Bob');

    await t.test('old direct writes silently affect no rows under RLS; the new RPC confirms an actual ban', async () => {
      assert.equal((await asRole('authenticated',admin,() => db.query("update public.players set is_banned=true where name='Alice' returning name"))).rows.length,0);
      assert.equal((await asRole('authenticated',admin,() => db.query("delete from public.players where name='Alice' returning name"))).rows.length,0);
      const before = (await db.query('select * from public.player_matches order by id')).rows;
      const reply = await moderate('Alice','ban');
      confirmPlayerModeration(reply,null,'Alice','ban');
      const rows = await players();
      assert.equal(rows.find(p => p.name === 'Alice').is_banned,true);
      assert.equal(rows.find(p => p.name === 'Alice').rank,999999);
      assert.equal(rows.find(p => p.name === 'Bob').rank,1);
      assert.ok(!rankPlayers(rows).some(p => p.name === 'Alice'));
      assert.equal(recordHolder(rows)?.name,'Bob');
      assert.equal(statMedals(rows).has('Alice'),false);
      assert.deepEqual((await db.query('select * from public.player_matches order by id')).rows,before);
      assert.equal((await db.query<any>("select * from public.audit_logs where action='BAN_PLAYER'")).rows[0].admin_user,admin);
    });

    await t.test('a user cannot self-unban; normal users, anonymous callers and forged client admin claims are rejected', async () => {
      const before = await snapshot();
      await assert.rejects(asRole('authenticated',alice,() => db.query("update public.players set is_banned=false where name='Alice'")),{code:'42501'});
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({is_admin:true,user_metadata:{isAdmin:true}})]);
      for (const action of ['ban','unban','delete']) {
        await assert.rejects(moderate('Alice',action,bob),{code:'42501'});
        await assert.rejects(moderate('Alice',action,''),{code:'42501'});
        await assert.rejects(asRole('anon','',() => db.query('select public.admin_moderate_player($1,$2)',['Alice',action])),{code:'42501'});
      }
      assert.equal(await snapshot(),before);
    });

    await t.test('future imports preserve bans, and unbanning restores rankings without changing statistics', async () => {
      await importMatch('Alice');
      let rows = await players();
      assert.equal(rows.find(p => p.name === 'Alice').is_banned,true);
      assert.equal(rows.find(p => p.name === 'Alice').rank,999999);
      assert.equal(recordHolder(rows)?.name,'Bob');
      const stats = rows.find(p => p.name === 'Alice');
      const reply = await moderate('Alice','unban');
      confirmPlayerModeration(reply,null,'Alice','unban');
      rows = await players();
      assert.equal(rows.find(p => p.name === 'Alice').rank,1);
      assert.deepEqual(rows.find(p => p.name === 'Alice'),{...stats,is_banned:false,rank:1});
      assert.equal(statMedals(rows).get('Alice')?.accuracy,'gold');
    });

    await t.test('missing/stale names, invalid actions and revoked admins cannot produce false success', async () => {
      const before = await snapshot();
      await assert.rejects(moderate('Missing','delete'),{code:'40001'});
      for (const action of ['promote','',null]) await assert.rejects(moderate('Alice',action),{code:'22023'});
      assert.equal(await snapshot(),before);
      await db.exec("update public.players set is_admin=false where name='Admin'");
      await assert.rejects(moderate('Alice','delete'),{code:'42501'});
      await db.exec("update public.players set is_admin=true where name='Admin'");
    });

    await t.test('audit failure rolls back deletion including raw matches, private data and revision', async () => {
      await db.exec(`
        insert into public.player_profile_details(user_id,bio,setup) values('${bob}','Test bio','{"mouse":"Example"}');
        insert into public.battlenet_account_links(account_id,user_id,battletag,log_name) values('123','${bob}','Bob#1234','Bob');
        insert into public.battlenet_oauth_requests(state_hash,user_id,redirect_url,browser_hash)
          values(repeat('a',64),'${bob}','https://widowhs.com/',repeat('b',64));
        create function fail_moderation_audit() returns trigger language plpgsql as $$begin
          if new.action='DELETE_PLAYER' then raise exception 'Audit unavailable'; end if; return new;
        end$$;
        create trigger fail_moderation_audit before insert on public.audit_logs for each row execute function fail_moderation_audit();
      `);
      const before = await snapshot();
      await assert.rejects(moderate('Bob','delete'),/Audit unavailable/);
      assert.equal(await snapshot(),before);
      await db.exec('drop trigger fail_moderation_audit on public.audit_logs');
    });

    await t.test('deletion removes target history and orphaned private claims, preserving other players and auth users', async () => {
      const aliceBefore = (await players()).find(p => p.name === 'Alice');
      const aliceMatches = (await db.query("select * from public.player_matches where player_name='Alice' order by id")).rows;
      const revision = Number((await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision);
      const reply = await moderate('Bob','delete');
      confirmPlayerModeration(reply,null,'Bob','delete');
      assert.equal((await players()).some(p => p.name === 'Bob'),false);
      assert.deepEqual((await players()).find(p => p.name === 'Alice'),aliceBefore);
      assert.deepEqual((await db.query("select * from public.player_matches where player_name='Alice' order by id")).rows,aliceMatches);
      for (const table of ['player_matches','player_history','player_elo_legacy'])
        assert.equal((await db.query(`select * from public.${table} where player_name='Bob'`)).rows.length,0);
      for (const table of ['player_profile_details','battlenet_account_links','battlenet_oauth_requests'])
        assert.equal((await db.query(`select * from public.${table} where user_id=$1`,[bob])).rows.length,0);
      assert.equal((await db.query('select * from auth.users where id=$1',[bob])).rows.length,1);
      assert.ok(Number((await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision)>revision);
      await assert.rejects(moderate('Bob','delete'),{code:'40001'});
    });

    await t.test('deleting an additional profile preserves private data still used by another profile', async () => {
      await db.exec(`insert into public.players(name,user_id,matches,elo) values('Alias','${alice}',0,'-');
        insert into public.player_profile_details(user_id,bio) values('${alice}','Keep me');
        insert into public.battlenet_account_links(account_id,user_id,battletag,log_name) values('456','${alice}','Alice#1234','Alice');`);
      await moderate('Alias','delete');
      assert.equal((await db.query('select * from public.player_profile_details where user_id=$1',[alice])).rows.length,1);
      assert.equal((await db.query('select * from public.battlenet_account_links where user_id=$1',[alice])).rows.length,1);
      const before = await players();
      await db.exec(await migration(latest));
      assert.deepEqual(await players(),before);
    });
  } finally { await db.close(); }
});
