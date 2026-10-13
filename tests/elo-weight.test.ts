import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { scoreWeight, isQualified, placementMatches } from '../supabase/functions/_shared/elo-weight.ts';
import { calculateRating } from '../supabase/functions/_shared/rating.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { assignMatchId } from '../supabase/functions/_shared/match-upload.ts';

const cases: [number,number,number|null,number][] = [
  [1,10,20,1], [1,10,21,0], [14,59,300,0], [15,59,300,15/35],
  [14,60,300,14/35], [1,60,300,1/3], [34,179,300,179/180],
  [35,1,300,1], [1,180,300,1], [50,45,300,1], [0,0,null,1],
];
test('participation thresholds include exactly 10s, 15 kills, 60s, 35 kills and 180s',()=>{
  for(const [score,time_in_lobby,total_match_time,expected] of cases)
    assert.equal(scoreWeight({score,time_in_lobby,total_match_time}),expected);
  assert.equal(isQualified({matches:100,placement_matches:9}),false);
  assert.equal(isQualified({matches:12,placement_matches:10}),true);
  assert.equal(isQualified({matches:10}),true); // Before the server migration.
  const fractional = { matches: 10, elo_weight_sum: 3.51, placement_matches: 3 };
  assert.equal(placementMatches(fractional),3);
  assert.equal(isQualified(fractional),false);
});

const makeMatch=(name:string,kills=50,time=200,total:number|null=200,kpm=10,accuracy=60,kdr=2)=>assignMatchId([{
  player_name:name,score:kills,deaths:10,accuracy,kpm,kdr,crouches:100,
  time_in_lobby:time,total_match_time:total,played_at:'2026-10-13T12:00:00',
}]);
test('imports weight ELO inputs, keep raw ratings and stats, and skip excluded ELO snapshots',()=>{
  const first=buildMatchImport([],makeMatch('A'));
  const reduced=makeMatch('A',17,60,300,17,90,8.5);
  const combined=buildMatchImport(first.players,reduced);
  const w=17/35;
  const expected=calculateRating({kpm:(10+17*w)/(1+w),accuracy:(60+90*w)/(1+w),kdr:(2+8.5*w)/(1+w)});
  assert.equal(combined.players[0].elo,String(expected));
  assert.equal(combined.players[0].matches,2);
  assert.equal(combined.players[0].placement_matches,1);
  assert.equal(combined.players[0].kdr,'5.25');
  assert.equal(combined.matches[0].performance_score,calculateRating(reduced[0]));
  const excluded=buildMatchImport(combined.players,makeMatch('A',14,59,300,999,100,999));
  assert.equal(excluded.players[0].elo,combined.players[0].elo);
  assert.equal(excluded.players[0].elo_weight_sum,combined.players[0].elo_weight_sum);
  assert.equal(excluded.players[0].matches,3);
  assert.equal(excluded.players[0].placement_matches,1);
  assert.equal(excluded.history.length,0);
  const onlyExcluded=buildMatchImport([],makeMatch('New',2,20,300));
  assert.equal(onlyExcluded.players[0].elo,'-');
  assert.equal(onlyExcluded.players[0].rank,999999);
  assert.equal(onlyExcluded.players[0].placement_matches,0);
});

const alice='00000000-0000-0000-0000-000000000001';
const bob='00000000-0000-0000-0000-000000000002';
const admin='00000000-0000-0000-0000-000000000003';
const latest='20261013233000_weighted_elo_participation.sql';
const placementsMigration='20261014010000_count_fully_eligible_placements.sql';
const migration=(name:string)=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
for(const accounts of ['text[]','jsonb']) test(`weighted ELO survives old imports, account changes, daily history and reset (${accounts})`,async t=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values('${alice}'),('${bob}'),('${admin}');
      create table auth.identities(user_id uuid,provider text);
      insert into auth.identities values('${alice}','discord'),('${bob}','discord'),('${admin}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts ${accounts} default '${accounts==='jsonb'?'[]':'{}'}',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy double precision,kpm double precision,kdr double precision,crouches integer,time_in_lobby double precision,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values('Alice','${alice}',false,0,'-'),('Bob','${bob}',false,0,'-'),('Admin','${admin}',true,0,'-');
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update on public.players to authenticated;
    `);
    for(const name of ['20261005210000_admin_leaderboard_reset.sql','20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql','20261012130000_count_imported_rounds.sql','20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql','20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql','20261013180000_pb_rankings_and_records.sql',
      '20261013200000_profile_bio_and_setup.sql','20261013210000_public_elo_history.sql',
      '20261013220000_admin_profile_details_moderation.sql','20261013230000_daily_average_elo_history.sql'])
      await db.exec(await migration(name));
    await db.exec(`insert into public.players(name,matches,score,deaths,kdr,accuracy,kpm,crouches,time_in_lobby,elo)
      values('Legacy',3,90,30,'2','60%','10',300,600,'999');
      insert into public.player_matches(player_name,score,deaths,accuracy,kpm,kdr,crouches,time_in_lobby,total_match_time,performance_score)
      values('Legacy',30,10,60,10,2,100,200,200,707);
      insert into public.player_history(player_name,elo,rank,created_at) values('Legacy',999,1,'2026-10-01T12:00:00Z');`);
    await db.exec(await migration(latest));
    const beforePlacements=(await db.query<any>('select * from public.players order by name')).rows;
    const historyBeforePlacements=(await db.query<any>('select * from public.player_history order by id')).rows;
    await db.exec(await migration(placementsMigration));
    assert.deepEqual((await db.query<any>('select * from public.players order by name')).rows.map(({placement_matches,...rest})=>rest),beforePlacements);
    assert.deepEqual((await db.query<any>('select * from public.player_history order by id')).rows,historyBeforePlacements);
    const asRole=async<T>(role:string,actor:string,action:()=>Promise<T>)=>{
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
      await db.exec(`set role ${role}`); try { return await action(); } finally { await db.exec('reset role'); }
    };
    const profile=async(name:string)=>(await db.query<any>('select * from public.players where name=$1',[name])).rows[0];
    const importMatches=async(matches:ReturnType<typeof makeMatch>,stale=false)=>{
      const payload=buildMatchImport((await db.query<ImportPlayer>('select * from public.players')).rows,matches);
      if(stale) {
        for(const p of payload.players) { p.elo='9,999';p.tag='PRO';p.elo_weight_sum=999; }
        payload.history=payload.players.map(p=>({player_name:p.name,elo:9999,rank:1}));
      }
      const revision=(await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
      await asRole('service_role','',()=>db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','weight')",
        [revision,...[payload.players,payload.ranks,payload.history,payload.matches].map(v=>JSON.stringify(v))]));
      return payload;
    };
    await t.test('SQL and TypeScript agree at every threshold; legacy backfill retains unrecorded participation',async()=>{
      for(const [kills,time,total,expected] of cases) {
        const actual=Number((await db.query<any>('select public.match_elo_weight($1,$2,$3) w',[kills,time,total])).rows[0].w);
        assert.ok(Math.abs(actual-expected)<1e-12);
        assert.equal(buildMatchImport([],makeMatch('Threshold',kills,time,total)).players[0].placement_matches,expected===1?1:0);
      }
      const old=await profile('Legacy');
      assert.equal(Number(old.elo_weight_sum),3);
      assert.equal(old.placement_matches,3);
      assert.equal(Number(old.elo_kpm_sum),30);
      assert.equal(Number((await db.query<any>("select weight from public.player_elo_legacy where player_name='Legacy'")).rows[0].weight),2);
      assert.equal((await db.query<any>("select elo from public.player_history where player_name='Legacy' and history_day='2026-10-01'")).rows[0].elo,999);
    });
    await t.test('the server ignores stale or forged ELO; exclusion preserves stats without adding a daily sample',async()=>{
      await importMatches(makeMatch('Alice'),true);
      const reduced=makeMatch('Alice',17,60,300,17,90,8.5);
      await importMatches(reduced,true);
      const expected=buildMatchImport([], [...makeMatch('Alice'),...reduced]).players[0];
      let player=await profile('Alice');
      assert.equal(player.elo,expected.elo);
      assert.ok(Math.abs(Number(player.elo_weight_sum)-Number(expected.elo_weight_sum))<1e-12);
      assert.equal(player.kdr,'5.25');
      const historyBefore=(await db.query<any>("select elo_sum,elo_samples from public.player_history where player_name='Alice'")).rows;
      await importMatches(makeMatch('Alice',14,59,300,999,100,999),true);
      player=await profile('Alice');
      assert.equal(player.elo,expected.elo);
      assert.equal(player.matches,3);
      assert.deepEqual((await db.query<any>("select elo_sum,elo_samples from public.player_history where player_name='Alice'")).rows,historyBefore);
      const details=(await asRole('anon','',()=>db.query<any>('select public.get_match_details($1) as data',[reduced[0].match_id]))).rows[0].data;
      assert.equal(details[0].performance_score,calculateRating(reduced[0]));
      await importMatches(makeMatch('Excluded',14,59,300),true);
      assert.equal((await profile('Excluded')).elo,'-');
      assert.equal(Number((await db.query<any>("select count(*) n from public.player_history where player_name='Excluded'")).rows[0].n),0);
    });
    await t.test('only ten fully eligible matches qualify, even if reduced weights sum past ten',async()=>{
      await importMatches(Array.from({length:10},()=>makeMatch('Placements',15,60,300)).flat());
      assert.equal(isQualified(await profile('Placements')),false);
      assert.equal((await profile('Placements')).placement_matches,0);
      await importMatches(Array.from({length:6},()=>makeMatch('Placements')).flat());
      assert.ok(Number((await profile('Placements')).elo_weight_sum)>10);
      assert.equal((await profile('Placements')).placement_matches,6);
      assert.equal(isQualified(await profile('Placements')),false);
      await importMatches(Array.from({length:4},()=>makeMatch('Placements')).flat());
      assert.equal((await profile('Placements')).placement_matches,10);
      assert.equal(isQualified(await profile('Placements')),true);
    });
    await t.test('browser cache forgery is rederived and private functions/baselines remain inaccessible',async()=>{
      const before=await profile('Alice');
      await asRole('authenticated',alice,()=>db.query("update public.players set elo='9999',elo_weight_sum=99,elo_kpm_sum=9999,placement_matches=99,tag='PRO' where name='Alice'"));
      assert.equal((await profile('Alice')).elo,before.elo);
      assert.equal((await profile('Alice')).elo_weight_sum,before.elo_weight_sum);
      assert.equal((await profile('Alice')).placement_matches,1);
      for(const role of ['anon','authenticated','service_role'])
        await assert.rejects(asRole(role,alice,()=>db.query('select * from public.player_elo_legacy')),(e:any)=>e.code==='42501');
      await assert.rejects(db.query("update public.player_matches set elo_weight=1 where player_name='Alice'"));
    });
    await t.test('rename, full legacy merge and corrections preserve weights and winning PBs',async()=>{
      await asRole('authenticated',alice,()=>db.query("select public.rename_player('Alice','Renamed')"));
      const before=Number((await profile('Renamed')).elo_weight_sum);
      await asRole('service_role','',()=>db.query("select public.complete_battlenet_account_link($1,'100','Legacy#12345')",[alice]));
      assert.equal(await profile('Legacy'),undefined);
      assert.ok(Math.abs(Number((await profile('Renamed')).elo_weight_sum)-before-3)<1e-12);
      await asRole('authenticated',alice,()=>db.query("select public.rename_player('Renamed','Again')"));
      assert.equal(Number((await db.query<any>("select weight from public.player_elo_legacy where player_name='Again'")).rows[0].weight),2);
      await db.query("update public.player_matches set time_in_lobby=180 where player_name='Again' and score=17");
      assert.equal(Number((await profile('Again')).elo_weight_sum),5);
      assert.equal((await profile('Again')).placement_matches,5);
      assert.equal(Number((await profile('Again')).personal_best_time),200);
    });
    await t.test('verified priority moves only matching logs without transferring a foreign Discord profile',async()=>{
      await importMatches(makeMatch('Manual',17,60,300));
      await db.query("select public._link_bnet_account_impl($1,'Bob','Manual',false)",[bob]);
      const before=Number((await profile('Again')).elo_weight_sum);
      await asRole('service_role','',()=>db.query("select public.complete_battlenet_account_link($1,'101','Manual#12345')",[alice]));
      assert.equal((await profile('Bob')).user_id,bob);
      assert.equal(Number((await profile('Bob')).elo_weight_sum),0);
      assert.ok(Math.abs(Number((await profile('Again')).elo_weight_sum)-before-17/35)<1e-12);
      assert.equal((await profile('Again')).placement_matches,5);
    });
    await t.test('reinstall changes no history samples; admin reset clears legacy and weighted stats',async()=>{
      const before=(await db.query<any>('select * from public.player_history order by id')).rows;
      await db.exec(await migration(latest));
      await db.exec(await migration(placementsMigration));
      assert.deepEqual((await db.query<any>('select * from public.player_history order by id')).rows,before);
      await asRole('authenticated',admin,()=>db.query("select public.reset_leaderboard('RESET')"));
      const profiles=(await db.query<any>('select * from public.players')).rows;
      assert.ok(profiles.every(p=>p.placement_matches===0&&Number(p.elo_weight_sum)===0&&p.elo==='-'&&p.personal_best_time===null));
      assert.equal(Number((await db.query<any>('select count(*) n from public.player_elo_legacy')).rows[0].n),0);
      await importMatches(makeMatch('Again'));
      assert.equal(Number((await profile('Again')).elo_weight_sum),1);
      assert.equal((await profile('Again')).placement_matches,1);
      assert.equal((await profile('Again')).is_verified,true);
    });
  } finally { await db.close(); }
});
