import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { assignMatchId } from '../supabase/functions/_shared/match-upload.ts';

const alice = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const latest = '20261013230000_daily_average_elo_history.sql';
const migration = (name:string) => readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');

for (const idType of ['uuid', 'bigint']) test(`daily ELO averages preserve import, rename, merge and reset compatibility (${idType})`, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${alice}'),('${admin}');
      create table auth.identities(user_id uuid,provider text);
      insert into auth.identities values ('${alice}','discord'),('${admin}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts jsonb default '[]',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id ${idType === 'uuid' ? 'uuid default gen_random_uuid()' : 'bigint generated always as identity'} primary key,
        player_name text,elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values ('Alice','${alice}',false,0,'-'),('Admin','${admin}',true,0,'-');
    `);
    for(const name of ['20261005210000_admin_leaderboard_reset.sql','20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql','20261012130000_count_imported_rounds.sql','20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql','20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql','20261013180000_pb_rankings_and_records.sql',
      '20261013200000_profile_bio_and_setup.sql','20261013210000_public_elo_history.sql','20261013220000_admin_profile_details_moderation.sql'])
      await db.exec(await migration(name));
    await db.exec(`
      alter table public.player_history enable row level security;
      create policy legacy_insert_only on public.player_history for insert with check(true);
      grant select,insert,update,delete on public.player_history to anon,authenticated,service_role;
      insert into public.player_history(player_name,elo,rank,created_at) values
        ('Alice',100,3,'2026-10-01T09:00:00Z'),('Alice',200,2,'2026-10-01T10:00:00Z'),('Alice',400,1,'2026-10-01T11:00:00Z'),
        ('Alice',800,1,'2026-10-01T22:30:00Z');
    `);
    const playerBefore = (await db.query('select * from public.players order by name')).rows;
    await db.exec(await migration(latest));
    const asRole = async <T>(role:string, uid:string, action:()=>Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
      await db.exec(`set role ${role}`); try {return await action();} finally {await db.exec('reset role');}
    };
    const history = async (name:string, role='anon') => (await asRole(role,'',()=>db.query<any>('select * from public.get_player_elo_history($1)',[name]))).rows;
    const raw = async (name:string) => (await db.query<any>('select elo,elo_sum,elo_samples,history_day::text as history_day,rank from public.player_history where player_name=$1 order by history_day',[name])).rows;
    const insert = (name:string, elo:number, date:string) => db.query('insert into public.player_history(player_name,elo,created_at) values($1,$2,$3)',[name,elo,date]);

    await t.test('backfill stores one rounded daily average with exact sums/counts and changes no player stats',async()=>{
      const rows = await raw('Alice');
      assert.deepEqual(rows.map(row=>[row.elo,Number(row.elo_sum),Number(row.elo_samples)]),[[233,700,3],[800,800,1]]);
      assert.equal(rows[0].history_day,'2026-10-01');
      assert.equal(rows[1].history_day,'2026-10-02');
      assert.equal(rows[0].rank,1);
      assert.deepEqual((await db.query('select * from public.players order by name')).rows,playerBefore);
      assert.deepEqual((await history('Alice')).map(row=>row.elo),[233,800]);
    });

    await t.test('later samples use all original values rather than the rounded daily average',async()=>{
      await insert('Alice',600,'2026-10-01T12:00:00Z');
      assert.deepEqual((await raw('Alice')).map(row=>[row.elo,Number(row.elo_sum),Number(row.elo_samples)]),[[325,1300,4],[800,800,1]]);
      await insert('Alice',0,'2026-10-01T12:01:00Z');
      assert.equal((await raw('Alice'))[0].elo,260);
      assert.equal(Number((await raw('Alice'))[0].elo_samples),5);
    });

    await t.test('Berlin midnight and both DST transitions group the correct local day',async()=>{
      await db.query("insert into public.players(name,matches,elo) values('DST',0,'-')");
      for(const [elo,date] of [[100,'2026-03-29T00:30:00Z'],[300,'2026-03-29T01:30:00Z'],
        [400,'2026-10-25T00:30:00Z'],[800,'2026-10-25T01:30:00Z']] as const) await insert('DST',elo,date);
      assert.deepEqual((await raw('DST')).map(row=>[row.history_day,row.elo]),[['2026-03-29',200],['2026-10-25',600]]);
      assert.deepEqual((await history('DST')).map(row=>new Date(row.created_at).toISOString()),['2026-03-28T23:00:00.000Z','2026-10-24T22:00:00.000Z']);
    });

    await t.test('bulk imports and updates compact only affected names and days',async()=>{
      await db.query("insert into public.players(name,matches,elo) values('Bulk',0,'-')");
      await db.query("insert into public.player_history(player_name,elo,created_at) values('Bulk',10,'2026-10-03T10:00:00Z'),('Bulk',30,'2026-10-03T11:00:00Z'),('Bulk',90,'2026-10-04T10:00:00Z')");
      assert.deepEqual((await raw('Bulk')).map(row=>[row.elo,Number(row.elo_samples)]),[[20,2],[90,1]]);
      await db.query("update public.player_history set created_at='2026-10-03T12:00:00Z' where player_name='Bulk' and history_day='2026-10-04'");
      assert.deepEqual((await raw('Bulk')).map(row=>[row.elo,Number(row.elo_samples)]),[[43,3]]);
    });

    await t.test('old Edge import payloads still update one daily row and leave the rating formula unchanged',async()=>{
      const ratings:number[]=[];
      for(const kpm of [10,20]) {
        const matches=assignMatchId([{player_name:'Importer',score:50,deaths:10,accuracy:60,kpm,kdr:5,crouches:100,time_in_lobby:200,total_match_time:200,played_at:null}]);
        const payload=buildMatchImport((await db.query<ImportPlayer>('select * from public.players')).rows,matches);
        const revision=(await db.query<any>('select revision from public.leaderboard_state where singleton')).rows[0].revision;
        await asRole('service_role','',()=>db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','daily')",[revision,...[payload.players,payload.ranks,payload.history,payload.matches].map(x=>JSON.stringify(x))]));
        const player=(await db.query<any>("select * from public.players where name='Importer'")).rows[0];
        assert.equal(player.elo,payload.players.find(p=>p.name==='Importer')!.elo);
        ratings.push(Number(player.elo.replace(/,/g,'')));
      }
      const rows=await raw('Importer');
      assert.equal(rows.length,1);
      assert.equal(Number(rows[0].elo_samples),2);
      assert.equal(rows[0].elo,Math.round((ratings[0]+ratings[1])/2));
      assert.equal(Number((await db.query<any>("select count(*) as n from public.player_matches where player_name='Importer'")).rows[0].n),2);
    });

    await t.test('rename and overlapping account merges retain a correctly weighted daily mean',async()=>{
      const before=await raw('Alice');
      await asRole('authenticated',alice,()=>db.query("select public.rename_player('Alice','Renamed')"));
      assert.deepEqual(await raw('Renamed'),before);
      await db.query("insert into public.players(name,matches,elo) values('ImportedAccount',0,'-')");
      await insert('ImportedAccount',1000,'2026-10-01T12:02:00Z');
      await insert('ImportedAccount',1000,'2026-10-01T12:03:00Z');
      await insert('ImportedAccount',400,'2026-10-02T12:00:00Z');
      await asRole('service_role','',()=>db.query("select public.complete_battlenet_account_link($1,'100','ImportedAccount#12345')",[alice]));
      const rows=await raw('Renamed');
      assert.equal(rows[0].elo,471);
      assert.equal(Number(rows[0].elo_sum),3300);
      assert.equal(Number(rows[0].elo_samples),7);
      assert.equal(rows[1].elo,600);
      assert.equal(Number(rows[1].elo_samples),2);
      assert.deepEqual(await raw('ImportedAccount'),[]);
    });

    await t.test('public reads expose only the newest 30 active days without synthetic inactive-day entries',async()=>{
      await db.query("insert into public.players(name,matches,elo) values('Long',0,'-')");
      await db.query("insert into public.player_history(player_name,elo,created_at) select 'Long',n,'2026-01-01T12:00:00Z'::timestamptz+n*interval '1 day' from generate_series(1,45)n");
      for(const role of ['anon','authenticated']) {
        const rows=await history('Long',role);
        assert.deepEqual(rows.map(row=>row.elo),Array.from({length:30},(_,i)=>i+16));
        assert.deepEqual(Object.keys(rows[0]).sort(),['created_at','elo']);
      }
      assert.equal((await history('DST')).length,2);
      assert.deepEqual(await history('Missing'),[]);
    });

    await t.test('browsers cannot forge a sample or aggregate, or execute maintenance routines',async()=>{
      const before=await raw('Renamed');
      for(const role of ['anon','authenticated']) for(const sql of [
        "insert into public.player_history(player_name,elo) values('Renamed',9999)",
        "update public.player_history set elo_sum=9999 where player_name='Renamed'",
        'select public._compact_daily_elo_history()'])
        await assert.rejects(asRole(role,alice,()=>db.query(sql)),(e:any)=>e.code==='42501');
      assert.deepEqual(await raw('Renamed'),before);
    });

    await t.test('reinstall preserves sums/counts and subsequent updates still compute the exact mean',async()=>{
      const before=(await db.query('select * from public.player_history order by id')).rows;
      await db.exec(await migration(latest));
      assert.deepEqual((await db.query('select * from public.player_history order by id')).rows,before);
      await insert('Renamed',700,'2026-10-01T12:04:00Z');
      assert.equal((await raw('Renamed'))[0].elo,500);
      assert.equal(Number((await raw('Renamed'))[0].elo_samples),8);
    });

    await t.test('reset deletes daily averages while preserving identities, and later samples start fresh',async()=>{
      await asRole('authenticated',admin,()=>db.query("select public.reset_leaderboard('RESET')"));
      assert.deepEqual(await history('Renamed'),[]);
      assert.equal(Number((await db.query<any>('select count(*) as n from public.player_history')).rows[0].n),0);
      await insert('Renamed',750,'2026-10-05T12:00:00Z');
      assert.deepEqual((await raw('Renamed')).map(row=>[row.elo,Number(row.elo_sum),Number(row.elo_samples)]),[[750,750,1]]);
    });
  } finally {await db.close();}
});
