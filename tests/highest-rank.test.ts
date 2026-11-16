import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { assignMatchId } from '../supabase/functions/_shared/match-upload.ts';

const alice = '00000000-0000-0000-0000-000000000001';
const bob = '00000000-0000-0000-0000-000000000002';
const admin = '00000000-0000-0000-0000-000000000003';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('highest leaderboard rank tracks qualified peak, survives drops and renames, resists forgery, and clears on reset', async () => {
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
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts text[] default '{}',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy double precision,kpm double precision,kdr double precision,crouches integer,time_in_lobby double precision,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values
        ('Alice','${alice}',false,0,'-'),('Bob','${bob}',false,0,'-'),('Admin','${admin}',true,0,'-');
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update on public.players to authenticated;
    `);
    for (const name of [
      '20261005210000_admin_leaderboard_reset.sql', '20261012110000_preserve_player_history_on_rename.sql',
      '20261012120000_add_match_date.sql', '20261012130000_count_imported_rounds.sql', '20261012140000_global_match_history.sql',
      '20261012220000_battlenet_oauth.sql', '20261013010000_battlenet_owned_profile_claims.sql',
      '20261013140000_verified_battlenet_claim_priority.sql', '20261013180000_pb_rankings_and_records.sql',
      '20261013200000_profile_bio_and_setup.sql', '20261013210000_public_elo_history.sql',
      '20261013220000_admin_profile_details_moderation.sql', '20261013230000_daily_average_elo_history.sql',
      '20261013233000_weighted_elo_participation.sql', '20261014010000_count_fully_eligible_placements.sql',
      '20261015120000_admin_player_moderation.sql', '20261023120000_recent_100_performance.sql',
      '20261031171500_batch_match_import.sql', '20261101182500_server_side_leaderboard_and_profile.sql',
      '20261102024500_daily_match_average_elo_history.sql', '20261108182500_three_battlenet_accounts.sql',
      '20261108190000_admin_merge_unverified_players.sql', '20261112020000_track_match_session_times.sql',
      '20261112190000_distinct_player_count_global_matches.sql', '20261113190000_elo_weight_use_active_time.sql',
      '20261115200000_combine_round_sessions.sql', '20261116170000_track_highest_leaderboard_rank.sql',
    ]) await db.exec(await migration(name));

    const asRole = async <T>(role: string, uid: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec('reset role'); }
    };
    const profile = async (name: string) => (await db.query<any>('select * from public.players where name=$1', [name])).rows[0];
    const importRounds = async (name: string, count: number, kpm: number, accuracy: number, kdr: number) => {
      for (let i = 0; i < count; i++) {
        const rows = assignMatchId([{
          player_name: name, score: 50, deaths: 10, accuracy, kpm, kdr, crouches: 50,
          time_in_lobby: 200, active_time: 200, total_match_time: 200, played_at: `2026-11-16T12:${String(i).padStart(2, '0')}:00`,
        }]);
        const payload = buildMatchImport((await db.query<ImportPlayer>('select * from public.players')).rows, rows);
        const revision = (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
        await asRole('service_role', '', () => db.query(
          "select public.apply_match_import($1,$2,$3,$4,$5,'TEST','highest-rank')",
          [revision, ...[payload.players, payload.ranks, payload.history, payload.matches].map(v => JSON.stringify(v))],
        ));
      }
    };

    // Placements (<10) never receive a highest_rank.
    await importRounds('Alice', 9, 20, 70, 5);
    assert.equal((await profile('Alice')).highest_rank, null);

    // Reaching 10 placements assigns qualified rank #1.
    await importRounds('Alice', 1, 20, 70, 5);
    assert.equal((await profile('Alice')).highest_rank, 1);

    // Bob overtakes Alice (#1 Bob, #2 Alice); Alice keeps highest_rank = 1.
    await importRounds('Bob', 10, 25, 75, 6);
    assert.equal((await profile('Bob')).highest_rank, 1);
    assert.equal((await profile('Alice')).highest_rank, 1);
    assert.equal((await profile('Alice')).rank, 2);

    // Authenticated client cannot forge highest_rank.
    await assert.rejects(
      asRole('authenticated', bob, () => db.query("update public.players set highest_rank = 99 where name = 'Bob'")),
      (e: any) => e.code === '42501',
    );

    // Renaming preserves highest_rank.
    await asRole('authenticated', alice, () => db.query("select public.rename_player('Alice', 'AliceRenamed')"));
    assert.equal((await profile('AliceRenamed')).highest_rank, 1);

    // Reset clears highest_rank back to null.
    await asRole('authenticated', admin, () => db.query("select public.reset_leaderboard('RESET')"));
    assert.equal((await profile('AliceRenamed')).highest_rank, null);
    assert.equal((await profile('Bob')).highest_rank, null);
  } finally { await db.close(); }
});
