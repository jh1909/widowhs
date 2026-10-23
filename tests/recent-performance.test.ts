import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { calculateRating } from '../supabase/functions/_shared/rating.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { assignMatchId } from '../supabase/functions/_shared/match-upload.ts';
import { getAchievements } from '../src/lib/achievements.ts';
import { formatPlayerKdr } from '../src/lib/player-kdr.ts';
import { crouchesPerMatch, crouchesPerMinute, formatPlayerAccuracy, formatPlayerPace } from '../src/lib/profile-stats.ts';
import { statMedals } from '../src/lib/stat-medals.ts';

const actor = '00000000-0000-0000-0000-000000000001';
const latest = '20261023120000_recent_100_performance.sql';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

for (const accounts of ['text[]', 'jsonb']) test(`recent performance and lifetime records (${accounts})`, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key); insert into auth.users values('${actor}');
      create table auth.identities(user_id uuid,provider text); insert into auth.identities values('${actor}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts ${accounts} default '${accounts === 'jsonb' ? '[]' : '{}'}',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy double precision,kpm double precision,kdr double precision,crouches integer,
        time_in_lobby double precision,total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values('A','${actor}',true,0,'-');
      grant select,insert,update on public.players to authenticated;
    `);
    for (const name of ['20261005210000_admin_leaderboard_reset.sql', '20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql', '20261012130000_count_imported_rounds.sql', '20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql', '20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql', '20261013180000_pb_rankings_and_records.sql',
      '20261013200000_profile_bio_and_setup.sql', '20261013210000_public_elo_history.sql',
      '20261013220000_admin_profile_details_moderation.sql', '20261013230000_daily_average_elo_history.sql',
      '20261013233000_weighted_elo_participation.sql', '20261014010000_count_fully_eligible_placements.sql',
      '20261015120000_admin_player_moderation.sql']) await db.exec(await migration(name));

    const profile = async (name = 'A') => (await db.query<any>('select * from public.players where name=$1', [name])).rows[0];
    const raw = (name: string, day: string, overrides = {}) => assignMatchId([{
      player_name: name, score: 50, deaths: 25, accuracy: 50, kpm: 10, kdr: 2, crouches: 20,
      time_in_lobby: 300, total_match_time: 300, played_at: day, ...overrides,
    }])[0];
    const upload = async (matches: ReturnType<typeof raw>[]) => {
      const payload = buildMatchImport((await db.query<ImportPlayer>('select * from public.players')).rows, matches);
      // Simulate old/forged precomputed ELO: only raw match rows are authoritative.
      for (const p of payload.players) p.elo = '9,999';
      const revision = (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
      await db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','recent')",
        [revision, ...[payload.players, payload.ranks, payload.history, payload.matches].map(v => JSON.stringify(v))]);
    };
    await upload([raw('A', '2026-01-01T12:00:00', { time_in_lobby: 100, total_match_time: 170, kpm: 30, accuracy: 90, kdr: 8 })]);
    await upload(Array.from({ length: 100 }, (_, i) => raw('A', `2026-10-01T12:${String(i % 60).padStart(2, '0')}:00`)));
    const lifetimeBefore = await profile();
    const oldHistory = (await db.query<any>('select * from public.player_history order by id')).rows;
    await db.exec(await migration(latest));

    await t.test('short windows use available eligible logs and never invent legacy rounds', async () => {
      await upload([raw('Short', '2026-10-22T12:00:00', { accuracy: 60, kdr: 3, kpm: 15 }),
        raw('Short', '2026-10-23T12:00:00', { score: 1, time_in_lobby: 10, total_match_time: 300 })]);
      const p = await profile('Short');
      assert.equal(p.recent_matches, 1);
      assert.equal(p.matches, 2);
      assert.equal(Number(p.recent_accuracy), 60);
      assert.equal(Number(p.recent_kdr), 3);
      assert.equal(Number(p.recent_kpm), 15);
      assert.equal(Number(p.elo.replace(/,/g, '')), calculateRating({ accuracy: 60, kdr: 3, kpm: 15 }));
      await db.exec(`insert into public.players(name,matches,kdr,accuracy,kpm,elo)
        values('LegacyOnly',500,'4','80%','20','2000');
        insert into public.player_elo_legacy values('LegacyOnly',500,10000,40000,2000);
        update public.players set elo=elo where name='LegacyOnly';`);
      const legacy = await profile('LegacyOnly');
      assert.equal(legacy.matches, 500);
      assert.equal(legacy.placement_matches, 500);
      assert.equal(legacy.recent_matches, 0);
      assert.equal(legacy.recent_kdr, null);
      assert.equal(legacy.speedrunner_count, 0);
      assert.equal(legacy.elo, '-');
    });

    await t.test('migration evicts old performance, keeps lifetime aggregates/PB and past samples', async () => {
      const p = await profile();
      for (const field of ['matches','score','deaths','crouches','time_in_lobby','kdr','accuracy','kpm','personal_best_time','placement_matches'])
        assert.equal(p[field], lifetimeBefore[field], field);
      assert.equal(p.recent_matches, 100);
      assert.equal(Number(p.elo_weight_sum), 100);
      assert.equal(Number(p.recent_accuracy), 50);
      assert.equal(Number(p.recent_kpm), 10);
      assert.equal(Number(p.recent_kdr), 2);
      assert.equal(Number(p.personal_best_time), 100);
      assert.equal(p.speedrunner_count, 1);
      assert.equal(Number(p.elo.replace(/,/g, '')), calculateRating({ kdr: 2, accuracy: 50, kpm: 10 }));
      const history = (await db.query<any>('select * from public.player_history order by id')).rows;
      assert.equal(Number(history[0].elo_samples), Number(oldHistory[0].elo_samples) + 1);
    });

    await t.test('ineligible rounds never consume window slots; late imports use played time', async () => {
      const before = await profile();
      await upload(Array.from({ length: 110 }, () => raw('A', '2026-10-22T12:00:00', {
        score: 1, time_in_lobby: 10, total_match_time: 300, kdr: 999, kpm: 999, accuracy: 100,
      })));
      await upload([raw('A', '2025-01-01T12:00:00', { accuracy: 1, kpm: 1, kdr: 1 })]);
      const p = await profile();
      assert.equal(p.recent_matches, 100);
      assert.equal(p.elo, before.elo);
      assert.equal(p.recent_crouches, before.recent_crouches);
      assert.equal(p.matches, 212);
    });

    await t.test('reduced rounds occupy one slot and retain their ELO weight and actual crouch time', async () => {
      await upload([raw('A', '2026-10-23T12:00:00', { score: 15, time_in_lobby: 60, total_match_time: 300,
        accuracy: 80, kpm: 20, kdr: 4, crouches: 100 })]);
      const p = await profile();
      const weight = 15 / 35;
      assert.equal(p.recent_matches, 100);
      assert.ok(Math.abs(Number(p.elo_weight_sum) - (99 + weight)) < 1e-10);
      assert.equal(Number(p.elo.replace(/,/g, '')), calculateRating({
        accuracy: (99 * 50 + 80 * weight) / (99 + weight), kpm: (99 * 10 + 20 * weight) / (99 + weight),
        kdr: (99 * 2 + 4 * weight) / (99 + weight),
      }));
      assert.equal(crouchesPerMatch(p), 20.8);
      assert.equal(crouchesPerMinute(p), 2080 / (29760 / 60));
      assert.equal(p.speedrunner_count, 1);
    });

    await t.test('lifetime Speedrunner count exceeds row limits and rejects 180s/losses/missing time', async () => {
      await upload(Array.from({ length: 1001 }, () => raw('Fast', '2026-01-01T12:00:00', {
        time_in_lobby: 170, total_match_time: 179,
      })));
      await upload([raw('Fast', '2026-10-01T12:00:00', { total_match_time: 180 }),
        raw('Fast', '2026-10-01T12:00:00', { score: 49, total_match_time: 179 }),
        raw('Fast', '2026-10-01T12:00:00', { total_match_time: null })]);
      const p = await profile('Fast');
      assert.equal(p.speedrunner_count, 1001);
      assert.equal(p.recent_matches, 100);
      assert.equal(getAchievements(p).find(b => b.id === 'speedrunner')?.count, 1001);
    });

    await t.test('server rejects cache forgery and refreshes dates, corrections, transfers and deletions', async () => {
      const before = await profile();
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
      await db.exec(`set role authenticated;
        update public.players set recent_accuracy=100,recent_matches=999,speedrunner_count=999,elo='9999' where name='A';
        reset role;`);
      assert.equal((await profile()).recent_accuracy, before.recent_accuracy);
      assert.equal((await profile()).speedrunner_count, 1);
      await db.exec("update public.player_matches set total_match_time=180 where player_name='A' and total_match_time=170");
      assert.equal((await profile()).speedrunner_count, 0);
      await db.exec("set role authenticated; select public.rename_player('A','Renamed'); reset role;");
      assert.equal((await profile('Renamed')).elo, before.elo);
      await db.query("select public._link_bnet_account_impl($1,'Renamed','Fast',false)", [actor]);
      const merged = await profile('Renamed');
      assert.equal(merged.speedrunner_count, 1001);
      assert.equal(merged.recent_matches, 100);
      assert.equal(merged.matches, 1217);
      await db.exec("update public.player_matches set played_at='2027-01-01' where player_name='Renamed' and total_match_time=180 and time_in_lobby=100");
      assert.ok(Number((await profile('Renamed')).recent_accuracy) > Number(merged.recent_accuracy));
      await db.exec("delete from public.player_matches where player_name='Renamed' and total_match_time=179");
      assert.equal((await profile('Renamed')).speedrunner_count, 0);
    });

    await t.test('reapplying migration is idempotent; reset clears derived stats', async () => {
      const history = (await db.query<any>('select * from public.player_history order by id')).rows;
      await db.exec(await migration(latest));
      assert.deepEqual((await db.query<any>('select * from public.player_history order by id')).rows, history);
      await db.exec("set role authenticated; select public.reset_leaderboard('RESET'); reset role;");
      const p = await profile('Renamed');
      assert.equal(p.matches, 0);
      assert.equal(p.speedrunner_count, 0);
      assert.equal(p.recent_matches, 0);
      assert.equal(p.recent_kdr, null);
      assert.equal(p.elo, '-');
    });
  } finally { await db.close(); }
});

test('all performance displays and medals use recent statistics; empty windows never fall back to lifetime', () => {
  const p = { name: 'Recent', elo: 1000, matches: 1000, placement_matches: 10, kdr: 9, accuracy: '99%', kpm: 50,
    crouches: 10000, time_in_lobby: 10000, recent_matches: 2, recent_kdr: '1.50', recent_accuracy: 45,
    recent_kpm: 12, recent_crouches: 200, recent_time_in_lobby: 600 };
  assert.equal(formatPlayerKdr(p), '1.50');
  assert.equal(formatPlayerAccuracy(p), '45.00%');
  assert.equal(formatPlayerPace(p), '12.00');
  assert.equal(crouchesPerMatch(p), 100);
  assert.equal(crouchesPerMinute(p), 20);
  assert.equal(getAchievements(p).find(b => b.id === 'sharpshooter')?.tier, 1);
  assert.ok(getAchievements(p).some(b => b.id === 'veteran'));
  assert.ok(!getAchievements(p).some(b => b.id === 'slayer'));
  const competitor = { ...p, name: 'Competitor', recent_kdr: '2', recent_accuracy: 50, recent_kpm: 15 };
  assert.equal(statMedals([p, competitor]).get(p.name)?.accuracy, 'silver');
  const empty = { ...p, recent_matches: 0, recent_kdr: null, recent_accuracy: null, recent_kpm: null,
    recent_crouches: 0, recent_time_in_lobby: 0 };
  assert.equal(formatPlayerKdr(empty), '—');
  assert.equal(formatPlayerAccuracy(empty), '—');
  assert.equal(formatPlayerPace(empty), '—');
  assert.equal(crouchesPerMatch(empty), null);
  assert.equal(crouchesPerMinute(empty), null);
  assert.ok(!getAchievements(empty).some(b => ['slayer', 'sharpshooter', 'fitness', 'no-croucher'].includes(b.id)));
});
