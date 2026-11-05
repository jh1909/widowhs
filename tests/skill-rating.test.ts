import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Papa from 'papaparse';
import { normalizeMatchLog } from '../supabase/functions/upload-csv/parser.ts';
import { prepareRound, type PreparedRound } from '../supabase/functions/_shared/log-ingest.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { DEFAULT_SR_PARAMS, lobbySizeWeight, normaliseIntervals, rateRound, replay, timeKey, type SrParams, type SrPlayer, type SrRound } from '../supabase/functions/_shared/sr.ts';

const actor = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const rows = (text: string) => Papa.parse<string[]>(normalizeMatchLog(text), {
  delimiter: ',', header: false, skipEmptyLines: 'greedy' }).data;
const SR_MIGRATION = '20261104120000_skill_rating.sql';
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

// One v1 line: name, kills, time in lobby, total match time.
const v1 = (...players: [string, number, number, number][]) =>
  players.map(([name, kills, time, total]) => `${name},${kills},10,50,5,1,0,${time},${total}`).join('\n');

// Bob leaves and rejoins, Carol is kicked; Alice wins.
const v2Log = `#V,2,3.5.0
#R,301.5,Alice
#P,1,Alice,0,0,301.5,0,50,20,120,60,5,0
#P,2,Bob,1,0,100,1,10,15,80,20,2,12.5
#P,3,Carol,2,10.25,200,2,5,12,30,8,1,75
#P,4,Bob,1,150,301.5,0,8,10,40,12,3,0`;

async function setup(beforeSr?: (db: PGlite) => Promise<void>, beforeLobby?: (db: PGlite) => Promise<void>) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; grant usage on schema auth to anon,authenticated,service_role;
    grant usage on schema public to anon,authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key); insert into auth.users values('${actor}'),('${other}');
    create table auth.identities(user_id uuid,provider text);
    insert into auth.identities values('${actor}','discord'),('${other}','discord');
    create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
      bnet_accounts jsonb default '[]',matches integer,score integer,deaths integer,
      kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
    create table public.player_matches(id bigint generated always as identity primary key,player_name text,
      score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
      performance_score integer,created_at timestamptz default now());
    create table public.player_history(id uuid default gen_random_uuid() primary key,
      player_name text,elo integer,rank integer,created_at timestamptz default now());
    create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
    insert into public.players(name,user_id,is_admin,matches,elo) values('Admin','${actor}',true,0,'-');
    grant select,insert,update on public.players to authenticated;
    -- As production: anyone could insert rounds.
    alter table public.player_matches enable row level security;
    create policy "Allow public read access" on public.player_matches for select using (true);
    create policy "Allow public insert access" on public.player_matches for insert with check (true);
    grant all on public.player_matches to anon, authenticated;
    grant all on sequence public.player_matches_id_seq to anon, authenticated;
  `);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
    if (name === SR_MIGRATION && beforeSr) await beforeSr(db);
    if (name === '20261104200000_sr_lobby_size.sql' && beforeLobby) await beforeLobby(db);
    await db.exec(await migration(name));
  }
  // Supabase sessions print floats with 15 significant digits; anything that
  // passes ratings through text must still be exact there.
  await db.exec('set extra_float_digits = 0');
  // Reads compare exact values.
  const read = async (sql: string, params: unknown[] = []) => {
    await db.exec('set extra_float_digits = 3');
    try { return (await db.query<any>(sql, params)).rows; } finally { await db.exec('set extra_float_digits = 0'); }
  };

  let files = 0;
  const round = (text: string, playedAt: string) => {
    files++;
    // A unique comment-free variant keeps each file's hash distinct.
    const body = text.startsWith('#V') ? text.replace(/^#V,[23],[^\n]+/, header => `${header}-${files}`) : `${text}\nUnknown,${files},0,0,0,0,0,0,0`;
    return prepareRound({ name: `Log-${files}.txt`, text: body, played_at: playedAt, host_name: 'Test' }, rows(body));
  };
  const upload = async (...rounds: PreparedRound[]) => {
    const players = (await db.query<ImportPlayer>('select * from public.players')).rows;
    const payload = buildMatchImport(players, rounds.flatMap(r => r.matches));
    const revision = (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
    await db.exec('set role service_role');
    try {
      await db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','sr',$6,$7)",
        [revision, ...[payload.players, payload.ranks, payload.history, payload.matches,
          rounds.map(r => r.raw_log), rounds.flatMap(r => r.kill_pairs)].map(v => JSON.stringify(v))]);
    } finally {
      await db.exec('reset role');
    }
    return rounds.map(r => r.raw_log.match_id);
  };
  const asAdmin = async (sql: string, params: unknown[] = []) => {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec('set role authenticated');
    try { return (await db.query<any>(sql, params)).rows; } finally { await db.exec('reset role'); }
  };
  const inputs = async () => (await db.query<any>('select * from public._sr_round_inputs()')).rows;
  const ratings = async () => ({
    events: await read(`select * from public.rating_events order by played_at, match_id::text, player_name`),
    players: await read('select * from public.player_ratings order by player_name'),
    rounds: await read('select * from public.round_ratings order by played_at, match_id::text'),
  });
  // Transaction ids of each event row: a row rewritten by a replay gets a new one.
  const versions = async () => new Map((await db.query<any>(
    `select match_id::text || '/' || player_name as k, xmin::text as v from public.rating_events`)).rows.map(r => [r.k, r.v]));
  const roundsRewritten = async (before: Map<string, string>) => {
    const after = await versions();
    const changed = new Set<string>();
    for (const [k, v] of after) if (before.get(k) !== v) changed.add(k.split('/')[0]);
    for (const k of before.keys()) if (!after.has(k)) changed.add(k.split('/')[0]);
    return changed;
  };
  // Incremental state must equal a replay from scratch, exactly.
  const assertMatchesScratch = async () => {
    const incremental = await ratings();
    await db.exec('begin');
    try {
      await db.exec('delete from public.rating_events where true; delete from public.round_ratings where true; delete from public.player_ratings where true;');
      await db.query('select public.replay_ratings()');
      assert.deepEqual(await ratings(), incremental);
    } finally {
      await db.exec('rollback');
    }
  };
  return { db, read, round, upload, asAdmin, inputs, ratings, versions, roundsRewritten, assertMatchesScratch };
}

test('SR tables are hidden from the site', async () => {
  const { db } = await setup();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        for (const table of ['rating_params', 'player_ratings', 'rating_events', 'round_ratings', 'rating_replay_queue']) {
          await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, `${role} ${table}`);
        }
        await assert.rejects(db.query('select public.replay_ratings()'), /permission denied/);
        await assert.rejects(db.query('select * from public._sr_round_inputs()'), /permission denied/);
      } finally {
        await db.exec('reset role');
      }
    }
    const params = (await db.query<any>('select version, d, beta, settings, active from public.rating_params where active')).rows;
    // The active version is shared with the reference engine; the original is retained.
    assert.deepEqual(params, [{ version: 3, d: DEFAULT_SR_PARAMS.d, beta: DEFAULT_SR_PARAMS.beta,
      settings: DEFAULT_SR_PARAMS.settings, active: true }]);
    await assert.rejects(db.exec("insert into public.rating_params(version,d,beta,settings,active) values (4,400,0.1,'{}',true)"), /rating_params_one_active/);
  } finally {
    await db.close();
  }
});

test('input assembly turns stored rows into rounds', async t => {
  const { db, round, upload, inputs } = await setup();
  try {
    await t.test('v1: interval ending at the round end, sole top scorer at 50 wins, time capped at the round', async () => {
      const [id] = await upload(await round(v1(['Alice', 50, 300, 300], ['Bob', 30, 120, 300], ['Carol', 12, 305, 300]), '2026-10-01T10:00:00'));
      const [r] = (await inputs()).filter(i => i.match_id === id);
      assert.equal(r.round.length, 300);
      assert.equal(r.round.winner, 'Alice');
      assert.equal(r.round.playedAt, '2026-10-01T08:00:00.000000Z');
      assert.deepEqual(r.round.participants, [
        { name: 'Alice', kills: 50, present: 300, afk: 0, shots: null, intervals: [[0, 300]] },
        { name: 'Bob', kills: 30, present: 120, afk: 0, shots: null, intervals: [[180, 300]] },
        { name: 'Carol', kills: 12, present: 300, afk: 0, shots: null, intervals: [[0, 300]] },
      ]);
    });

    await t.test('v1: no winner on a tie at the top or below 50; duplicate rows of a profile merge', async () => {
      const [tie, short, dup] = await upload(
        await round(v1(['Alice', 50, 300, 300], ['Bob', 50, 300, 300]), '2026-10-01T11:00:00'),
        await round(v1(['Alice', 49, 300, 300], ['Bob', 20, 300, 300]), '2026-10-01T12:00:00'),
        // Two people logged as Hex and hex land on one profile, as in production.
        await round(v1(['hex', 19, 243, 243], ['Alice', 30, 243, 243], ['Hex', 6, 75, 243]), '2026-10-01T13:00:00'));
      const all = await inputs();
      assert.equal(all.find(i => i.match_id === tie).round.winner, null);
      assert.equal(all.find(i => i.match_id === short).round.winner, null);
      const merged = all.find(i => i.match_id === dup).round;
      assert.deepEqual(merged.participants.map((p: any) => [p.name, p.kills, p.present]), [['hex', 25, 243], ['Alice', 30, 243]]);
      assert.equal(merged.winner, null);
    });

    await t.test('v1: rows that disagree on the match time are several files and are not rated', async () => {
      const [id] = await upload(await round(v1(['Alice', 50, 300, 300], ['Bob', 50, 200, 210]), '2026-10-01T14:00:00'));
      assert.equal((await inputs()).some(i => i.match_id === id), false);
    });

    await t.test('v2: sessions, rejoins, AFK, shots and the logged winner', async () => {
      const [id] = await upload(await round(v2Log, '2026-10-02T10:00:00'));
      const [r] = (await inputs()).filter(i => i.match_id === id);
      assert.deepEqual(r.round, {
        id, playedAt: '2026-10-02T08:00:00.000000Z', length: 301.5, winner: 'Alice', participants: [
          { name: 'Alice', kills: 50, present: 301.5, afk: 0, shots: 120, intervals: [[0, 301.5]] },
          { name: 'Bob', kills: 18, present: 251.5, afk: 12.5, shots: 120, intervals: [[0, 100], [150, 301.5]] },
          { name: 'Carol', kills: 5, present: 189.75, afk: 75, shots: 30, intervals: [[10.25, 200]] },
        ] });
    });

    await t.test('v2: overlapping sessions of one profile count once', async () => {
      const [id] = await upload(await round(`#V,2,3.5.0
#R,300,Dup
#P,1,Dup,0,0,300,0,50,10,100,50,0,0
#P,2,dup,1,20,200,1,5,10,20,5,0,0
#P,3,Erin,2,0,300,0,20,10,100,50,0,0`, '2026-10-02T11:00:00'));
      const [r] = (await inputs()).filter(i => i.match_id === id);
      assert.deepEqual(r.round.participants.map((p: any) => [p.name, p.kills, p.present, p.intervals]),
        [['Dup', 55, 300, [[0, 300]]], ['Erin', 20, 300, [[0, 300]]]]);
      assert.equal(r.round.winner, 'Dup');
    });

    await t.test('banned players and rows without a profile are left out; a banned winner leaves no winner', async () => {
      const [id] = await upload(await round(v2Log, '2026-10-02T12:00:00'));
      await db.exec(`insert into public.player_matches(player_name,score,time_in_lobby,total_match_time,played_at,match_id)
        values ('Ghost', 40, 300, 301, '2026-10-02T10:00:00Z', '${id}')`);
      assert.ok(!(await inputs()).find(i => i.match_id === id).round.participants.some((p: any) => p.name === 'Ghost'));
      await db.exec("update public.players set is_banned = true where name = 'Alice'");
      const r = (await inputs()).find(i => i.match_id === id).round;
      assert.deepEqual(r.participants.map((p: any) => p.name), ['Bob', 'Carol']);
      assert.equal(r.winner, null);
    });

    await t.test('rounds come in time order, ties by match id', async () => {
      const all = await inputs();
      const keys = all.map(i => [new Date(i.played_at).getTime(), i.match_id]);
      const sorted = [...keys].sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      assert.deepEqual(keys, sorted);
    });
  } finally {
    await db.close();
  }
});

test('every history change replays from the right round', async t => {
  const s = await setup();
  const { db, round, upload, asAdmin, inputs, ratings, versions, roundsRewritten, assertMatchesScratch } = s;
  try {
    const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T20:00:00`;
    const ids: string[] = [];
    for (let n = 1; n <= 6; n++) {
      ids.push(...await upload(await round(v1(['Alice', 50, 300, 300], ['Bob', 20 + n, 300, 300],
        ['Carol', 10 + 2 * n, 250, 300], ...(n % 2 ? [['Dave', 30, 200, 300] as [string, number, number, number]] : [])), day(n * 2))));
    }

    await t.test('the migration rated history; each import of a newer round rates only it', async () => {
      const before = await versions();
      const [id] = await upload(await round(v2Log, day(14)));
      ids.push(id);
      assert.deepEqual([...await roundsRewritten(before)], [id]);
      const r = await ratings();
      assert.equal(r.rounds.length, 7);
      assert.equal(r.events.filter(e => e.match_id === id).length, 3);
      const alice = r.players.find(p => p.player_name === 'Alice');
      assert.equal(alice.full_rounds, 7);
      assert.equal(alice.cautious_sr, alice.sr - 2 * alice.uncertainty);
      assert.deepEqual(r.players.filter(p => p.rank !== null).map(p => p.player_name),
        r.players.filter(p => p.placed).sort((a, b) => b.cautious_sr - a.cautious_sr).map(p => p.player_name));
      await assertMatchesScratch();
    });

    await t.test('an upload older than rated rounds replays from it', async () => {
      const before = await versions();
      const [id] = await upload(await round(v1(['Alice', 40, 300, 300], ['Erin', 50, 300, 300]), day(7)));
      assert.deepEqual(await roundsRewritten(before), new Set([id, ...ids.slice(3)]));
      ids.splice(3, 0, id);
      await assertMatchesScratch();
    });

    await t.test('a rename relabels without re-rating', async () => {
      const before = await versions();
      await asAdmin("select public.rename_player('Bob', 'Robert')");
      const r = await ratings();
      assert.ok(!r.events.some(e => e.player_name === 'Bob'));
      assert.equal(r.events.filter(e => e.player_name === 'Robert').length, 7);
      assert.equal((await roundsRewritten(before)).size, ids.length - 1); // Bob was in every round but Erin's
      // Values are unchanged; only the name moved.
      await assertMatchesScratch();
    });

    await t.test('a merge into a profile without rounds relabels; into one with rounds it replays', async () => {
      await db.exec(`insert into public.players(name,user_id,matches,elo) values ('Discord','${actor}',0,'-')`);
      await db.query(`select public._link_bnet_account_impl($1, 'Discord', 'Carol', false)`, [actor]);
      assert.ok((await ratings()).players.some(p => p.player_name === 'Discord'));
      assert.ok(!(await ratings()).players.some(p => p.player_name === 'Carol'));
      await assertMatchesScratch();

      const before = await versions();
      await db.query(`select public._link_bnet_account_impl($1, 'Discord', 'Dave', false)`, [actor]);
      const first = (await db.query<any>(`select min(played_at) as t from public.rating_events where player_name = 'Discord'`)).rows[0].t;
      const rewritten = await roundsRewritten(before);
      // Dave first played in the first round, so everything from there is re-rated.
      assert.equal(rewritten.size, ids.length);
      assert.ok(first);
      assert.ok(!(await ratings()).players.some(p => p.player_name === 'Dave'));
      await assertMatchesScratch();
    });

    await t.test('releasing an unverified name moves its rows and replays', async () => {
      await db.exec(`insert into public.players(name,user_id,matches,elo) values ('Owner','${other}',0,'-')`);
      await db.exec(`update public.players set user_id = '${actor}' where name = 'Robert'`);
      await upload(await round(v1(['Fay', 33, 300, 300], ['Alice', 50, 300, 300]), day(13)));
      // Another user's profile holds Fay's rounds under an unverified Battle.net name.
      await db.exec(`update public.player_matches set player_name = 'Owner' where player_name = 'Fay';
        update public.players set bnet_accounts = '["Fay"]', matches = 1 where name = 'Owner';`);
      await assertMatchesScratch();
      const before = await versions();
      await db.query(`select public._release_unverified_bnet_name($1, 'Robert', 'Fay')`, [actor]);
      assert.ok((await roundsRewritten(before)).size > 0);
      assert.ok(!(await ratings()).events.some(e => e.player_name === 'Owner'));
      await assertMatchesScratch();
    });

    await t.test('a ban drops the player from their first round on; an unban restores them', async () => {
      const snapshot = await ratings();
      const before = await versions();
      await asAdmin("select public.admin_moderate_player('Erin', 'ban')");
      const firstErin = snapshot.events.find(e => e.player_name === 'Erin').played_at.getTime();
      const rewritten = await roundsRewritten(before);
      for (const e of snapshot.events) {
        assert.equal(rewritten.has(e.match_id), e.played_at.getTime() >= firstErin, `round ${e.match_id}`);
      }
      const banned = await ratings();
      assert.ok(!banned.events.some(e => e.player_name === 'Erin'));
      assert.ok(!banned.players.some(p => p.player_name === 'Erin'));
      await assertMatchesScratch();
      await asAdmin("select public.admin_moderate_player('Erin', 'unban')");
      assert.deepEqual(await ratings(), snapshot);
    });

    await t.test('deleting a player or a round replays from the first affected round', async () => {
      await asAdmin("select public.admin_moderate_player('Erin', 'delete')");
      assert.ok(!(await ratings()).events.some(e => e.player_name === 'Erin'));
      await assertMatchesScratch();
      const before = await versions();
      await db.query('delete from public.player_matches where match_id = $1', [ids[4]]);
      const rewritten = await roundsRewritten(before);
      assert.ok(rewritten.has(ids[4]) && !rewritten.has(ids[2]) && rewritten.has(ids[5]));
      assert.ok(!(await ratings()).rounds.some(r => r.match_id === ids[4]));
      await assertMatchesScratch();
    });

    await t.test('editing a round replays from it; edits that do not change rating inputs do nothing', async () => {
      let before = await versions();
      await db.query('update public.player_matches set performance_score = 1 where match_id = $1', [ids[2]]);
      assert.equal((await roundsRewritten(before)).size, 0);
      before = await versions();
      await db.query("update public.player_matches set score = 5 where match_id = $1 and player_name = 'Alice'", [ids[2]]);
      const rewritten = await roundsRewritten(before);
      assert.ok(rewritten.has(ids[2]) && !rewritten.has(ids[1]));
      await assertMatchesScratch();
    });

    await t.test('activating another parameter version replays everything with it', async () => {
      await db.exec(`update public.rating_params set active = false where version = 3;
        insert into public.rating_params (version, d, beta, settings, active)
        select 4, 300, beta, settings || '{"m": 8, "surpriseCap": null}', true from public.rating_params where version = 3;`);
      const r = await ratings();
      assert.ok(r.events.length > 0 && r.events.every(e => e.params_version === 4));
      assert.ok(r.rounds.every(x => x.params_version === 4));
      await assertMatchesScratch();
      await db.exec('update public.rating_params set active = false where version = 4');
      assert.deepEqual(await ratings(), { events: [], players: [], rounds: [] });
      await db.exec('update public.rating_params set active = true where version = 4');
      await assertMatchesScratch();
    });

    await t.test('a failed import or a failed replay leaves everything as it was', async () => {
      const before = await ratings();
      const matches = (await db.query<any>('select count(*)::int as n from public.player_matches')).rows[0].n;
      const late = await round(v1(['Alice', 50, 300, 300], ['Zed', 10, 300, 300]), day(28));
      await db.exec('begin');
      await upload(late);
      await assert.rejects(db.exec('select 1/0'));
      await db.exec('rollback');
      assert.deepEqual(await ratings(), before);
      const fn = (await db.query<any>(`select pg_get_functiondef(oid) as def, pg_get_function_arguments(oid) as args
        from pg_proc where proname = '_sr_rate_round'`)).rows[0];
      const saved = fn.def;
      await db.exec(`create or replace function public._sr_rate_round(${fn.args}) returns public._sr_round_result
        language plpgsql as $$ begin raise exception 'engine failed'; end $$;`);
      try {
        await assert.rejects(upload(await round(v1(['Alice', 50, 300, 300], ['Zed', 10, 300, 300]), day(29))), /engine failed/);
      } finally {
        await db.exec(saved);
      }
      assert.equal((await db.query<any>('select count(*)::int as n from public.player_matches')).rows[0].n, matches);
      assert.deepEqual(await ratings(), before);
      assert.equal((await db.query<any>('select count(*)::int as n from public.rating_replay_queue')).rows[0].n, 0);
    });

    await t.test('replay_ratings is a no-op when nothing is affected', async () => {
      const before = await versions();
      assert.equal((await db.query<any>("select public.replay_ratings('2030-01-01') as n")).rows[0].n, 0);
      assert.equal((await roundsRewritten(before)).size, 0);
    });

    await t.test('corrections to sessions and raw logs replay from their round; other columns do nothing', async () => {
      const v2 = (await db.query<any>("select match_id from public.raw_logs where format_version = 2 order by uploaded_at limit 1")).rows[0].match_id;
      const earlier = (await db.query<any>(`select e.match_id from public.rating_events e
        where e.played_at < (select min(played_at) from public.player_matches where match_id = $1) limit 1`, [v2])).rows[0].match_id;
      let before = await versions();
      await db.query('update public.player_sessions set kills = kills + 1, crouches = 0 where match_id = $1', [v2]);
      assert.equal((await roundsRewritten(before)).size, 0);
      before = await versions();
      await db.query('update public.player_sessions set end_s = 120 where match_id = $1 and session_no = 2', [v2]);
      let rewritten = await roundsRewritten(before);
      assert.ok(rewritten.has(v2) && !rewritten.has(earlier));
      await assertMatchesScratch();
      before = await versions();
      await db.query("update public.raw_logs set winner_name = 'Robert' where match_id = $1", [v2]);
      rewritten = await roundsRewritten(before);
      assert.ok(rewritten.has(v2) && !rewritten.has(earlier));
      await assertMatchesScratch();
      await db.query("update public.raw_logs set round_length = 280 where match_id = $1", [v2]);
      await assertMatchesScratch();
      await db.query('delete from public.player_sessions where match_id = $1 and session_no = 3', [v2]);
      await assertMatchesScratch();
      await db.query('update public.raw_logs set filename = $2, host_name = $2 where match_id = $1', [v2, 'renamed.txt']);
      await assertMatchesScratch();
    });

    await t.test('an import replays once', async () => {
      await db.exec(`create table public.sr_replay_calls(at timestamptz default now());
        alter function public.replay_ratings(timestamptz) rename to replay_ratings_counted;
        create function public.replay_ratings(p_from timestamptz default '-infinity') returns integer language plpgsql as
          $$ begin insert into public.sr_replay_calls default values; return public.replay_ratings_counted(p_from); end $$;`);
      try {
        await upload(await round(v2Log, day(27)));
        assert.equal((await db.query<any>('select count(*)::int as n from public.sr_replay_calls')).rows[0].n, 1);
      } finally {
        await db.exec(`drop function public.replay_ratings(timestamptz); drop table public.sr_replay_calls;
          alter function public.replay_ratings_counted(timestamptz) rename to replay_ratings;`);
      }
      await assertMatchesScratch();
    });

    await t.test('renaming onto a name that already has rows rates those rows from their first round', async () => {
      // Rows under a name with no profile (not rated), one of them before every other round.
      await db.exec(`insert into public.player_matches(player_name, logged_player_name, score, deaths, accuracy, kpm, kdr, crouches,
          time_in_lobby, total_match_time, performance_score, played_at, match_id) values
        ('Lost', 'Lost', 50, 1, 50, 10, 5, 0, 300, 300, 800, '2026-09-01T12:00:00Z', '00000000-0000-0000-0000-0000000000f1'),
        ('Alice', 'Alice', 20, 1, 50, 4, 5, 0, 300, 300, 800, '2026-09-01T12:00:00Z', '00000000-0000-0000-0000-0000000000f1'),
        ('Gone', 'Gone', 50, 1, 50, 10, 5, 0, 300, 300, 800, '2026-09-02T12:00:00Z', '00000000-0000-0000-0000-0000000000f2'),
        ('Alice', 'Alice', 30, 1, 50, 4, 5, 0, 300, 300, 800, '2026-09-02T12:00:00Z', '00000000-0000-0000-0000-0000000000f2');
        insert into public.players(name, matches, elo) values ('Empty', 0, '-');`);
      await assertMatchesScratch();
      // A profile without rounds takes the name: its rows become rated.
      await asAdmin("select public.rename_player('Empty', 'Lost')");
      assert.ok((await ratings()).events.some(e => e.player_name === 'Lost'));
      await assertMatchesScratch();
      // A profile with later rounds takes the other name: replay from the earlier rows.
      await asAdmin("select public.rename_player('Robert', 'Gone')");
      assert.ok((await ratings()).events.some(e => e.player_name === 'Gone' && e.match_id === '00000000-0000-0000-0000-0000000000f2'));
      await assertMatchesScratch();
    });

    await t.test('moving a session to an earlier round through its participation replays from that round', async () => {
      const [early, late] = await upload(await round(v2Log, day(15)), await round(v2Log, day(16)));
      const carolEarly = (await db.query<any>("select id from public.player_matches where match_id = $1 and logged_player_name = 'Carol'", [early])).rows[0].id;
      // Bob's first session of the later round ([0, 100]) is attached to Carol's earlier participation; its match_id stays.
      const before = await versions();
      await db.query('update public.player_sessions set participation_id = $1 where match_id = $2 and session_no = 2', [carolEarly, late]);
      const rewritten = await roundsRewritten(before);
      assert.ok(rewritten.has(early) && rewritten.has(late));
      const carol = (await inputs()).find(i => i.match_id === early).round.participants.find((x: any) => x.intervals.length && x.kills === 5);
      assert.deepEqual(carol.intervals, [[0, 200]]);
      await assertMatchesScratch();
    });

    await t.test('a reset clears every rating', async () => {
      await asAdmin("select public.reset_leaderboard('RESET')");
      assert.deepEqual(await ratings(), { events: [], players: [], rounds: [] });
    });
  } finally {
    await db.close();
  }
});

test('browsers can read rounds but no longer write them', async () => {
  const { db } = await setup();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await db.query('select count(*) from public.player_matches');
        await assert.rejects(db.query("insert into public.player_matches(player_name, score) values ('X', 1)"), /permission denied/);
        await assert.rejects(db.query('delete from public.player_matches where true'), /permission denied/);
        await assert.rejects(db.query('truncate public.player_matches'), /permission denied/);
      } finally {
        await db.exec('reset role');
      }
    }
  } finally {
    await db.close();
  }
});

test('rows filed under an alias of exactly one profile move to it', async () => {
  const { db } = await setup(async db => {
    await db.exec(`
      insert into public.players(name, matches, elo, bnet_accounts, previous_names) values
        ('Prof', 2, '-', '["Linked"]', '{}'), ('Renamed', 1, '-', '[]', '{Old}'), ('Other', 2, '-', '[]', '{}'),
        ('A1', 0, '-', '["Amb"]', '{}'), ('A2', 0, '-', '[]', '{amb}');
      insert into public.player_matches(player_name, logged_player_name, score, deaths, accuracy, kpm, kdr, crouches,
        time_in_lobby, total_match_time, performance_score, played_at, match_id) values
        ('linked', 'linked', 50, 10, 50, 10, 5, 3, 200, 300, 800, '2026-10-11T12:00:00Z', '00000000-0000-0000-0000-00000000000a'),
        ('Other', 'Other', 30, 10, 40, 8, 3, 2, 300, 300, 600, '2026-10-11T12:00:00Z', '00000000-0000-0000-0000-00000000000a'),
        ('Prof', 'Linked', 20, 10, 40, 6, 2, 1, 300, 300, 500, '2026-10-12T12:00:00Z', '00000000-0000-0000-0000-00000000000b'),
        ('Other', 'Other', 50, 10, 40, 8, 3, 2, 300, 300, 600, '2026-10-12T12:00:00Z', '00000000-0000-0000-0000-00000000000b'),
        ('Old', 'Old', 10, 10, 40, 6, 1, 1, 300, 300, 300, '2026-10-12T13:00:00Z', '00000000-0000-0000-0000-00000000000c'),
        ('Amb', 'Amb', 10, 10, 40, 6, 1, 1, 300, 300, 300, '2026-10-12T14:00:00Z', '00000000-0000-0000-0000-00000000000d'),
        ('Nobody', 'Nobody', 10, 10, 40, 6, 1, 1, 300, 300, 300, '2026-10-12T15:00:00Z', '00000000-0000-0000-0000-00000000000e');
      insert into public.player_history(player_name, elo, rank, created_at) values ('linked', 800, 1, '2026-10-11T12:00:00Z');
    `);
  });
  try {
    const rows = (await db.query<any>('select player_name, logged_player_name from public.player_matches order by id')).rows;
    assert.deepEqual(rows.map(r => [r.player_name, r.logged_player_name]), [
      ['Prof', 'linked'], ['Other', 'Other'], ['Prof', 'Linked'], ['Other', 'Other'], ['Renamed', 'Old'], ['Amb', 'Amb'], ['Nobody', 'Nobody']]);
    const prof = (await db.query<any>(`select matches, personal_best_time::float as pb, placement_matches, recent_matches
      from public.players where name = 'Prof'`)).rows[0];
    // Lifetime counters already counted the rows; derived stats now include them.
    assert.deepEqual(prof, { matches: 2, pb: 200, placement_matches: 2, recent_matches: 2 });
    const history = (await db.query<any>("select player_name, elo_samples::int as n from public.player_history order by player_name")).rows;
    assert.ok(history.some(h => h.player_name === 'Prof') && !history.some(h => h.player_name === 'linked'));
    const events = (await db.query<any>("select player_name from public.rating_events where match_id = '00000000-0000-0000-0000-00000000000a' order by 1")).rows;
    assert.deepEqual(events.map(e => e.player_name), ['Other', 'Prof']);
  } finally {
    await db.close();
  }
});

// ---- Agreement with the TypeScript engine (supabase/functions/_shared/sr.ts) ----

const near = (a: number, b: number, what: string, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b}`);
const EVENT_NUMBERS = ['weight', 'srBefore', 'srAfter', 'uncertaintyBefore', 'uncertaintyAfter',
  'expectedShare', 'actualShare', 'performance'] as const;

function assertSameRound(ts: ReturnType<typeof rateRound>, db: any, what: string) {
  assert.deepEqual(db.events.map((e: any) => e.name), ts.events.map(e => e.name), `${what}: rated players`);
  ts.events.forEach((e, i) => {
    const d = db.events[i];
    assert.equal(d.full, e.full, `${what} ${e.name} full`);
    for (const key of EVENT_NUMBERS) near(d[key], e[key], `${what} ${e.name} ${key}`);
  });
  if (ts.lobby === null) assert.equal(db.lobby, null, `${what}: lobby`);
  else {
    assert.equal(db.lobby.players, ts.lobby.players, `${what}: lobby players`);
    near(db.lobby.meanSr, ts.lobby.meanSr, `${what} lobby mean`);
    near(db.lobby.minSr, ts.lobby.minSr, `${what} lobby min`);
    near(db.lobby.maxSr, ts.lobby.maxSr, `${what} lobby max`);
  }
}

const P = DEFAULT_SR_PARAMS;
const withSettings = (settings: Partial<SrParams['settings']>, top: Partial<SrParams> = {}): SrParams =>
  ({ ...P, ...top, settings: { ...P.settings, ...settings } });
const L = 300;
const p1 = (name: string, kills: number, present = L, length = L) =>
  ({ name, kills, present, afk: 0, shots: null, intervals: [[length - present, length]] as [number, number][] });
const p2 = (name: string, kills: number, intervals: [number, number][], shots: number, afk = 0) =>
  ({ name, kills, afk, shots, intervals, present: intervals.reduce((t, [s, e]) => t + e - s, 0) });
const rnd = (participants: SrRound['participants'], winner: string | null = null, length = L): SrRound =>
  ({ id: 'r1', playedAt: '2026-10-01T12:00:00Z', length, winner, participants });
const established = (sr: number, uncertainty = 50): SrPlayer => ({ sr, uncertainty, ratedWeight: 20, fullRounds: 20, lastRatedAt: null });
const lobbyOf = (ratings: Record<string, number>, uncertainty = 50) =>
  new Map(Object.entries(ratings).map(([name, sr]) => [name, established(sr, uncertainty)]));
const letters = 'ABCDEFGHIJKL'.split('');
const even = Object.fromEntries(letters.map(n => [n, 1500]));

// The fixtures of tests/sr.test.ts, as (state, round, params, seed).
const fixtures: [string, Map<string, SrPlayer>, SrRound, SrParams, Map<string, number>?][] = [
  ['golden', new Map([['B', established(1600, 80)]]), rnd([p1('A', 50), p1('B', 30)], 'A'), P],
  ['golden, prototype settings', new Map([['B', established(1600, 80)]]), rnd([p1('A', 50), p1('B', 30)], 'A'),
    withSettings({ m: 5, rd0: 350, rdMin: 50 }, { d: 400, beta: 0.1 })],
  ['eleven on 49', lobbyOf(even), rnd(letters.map((n, i) => p1(n, i ? 49 : 50)), 'A'), P],
  ['dominant winner', lobbyOf(even), rnd(letters.map((n, i) => p1(n, i ? 25 : 50)), 'A'), P],
  ['fourth far behind', lobbyOf({ A: 1500, B: 1500, C: 1500, D: 1500 }), rnd([p1('A', 50), p1('B', 47), p1('C', 45), p1('D', 32)], 'A'), P],
  ['strong in weak lobby', lobbyOf({ S: 1800, B: 1400, C: 1400, D: 1400, E: 1400, F: 1400 }),
    rnd([p1('S', 50), ...'BCDEF'.split('').map(n => p1(n, 45))], 'S'), P],
  ['late joiner at 45 s', lobbyOf({ A: 1500, B: 1500, C: 1500 }), rnd([p1('A', 50), p1('B', 40), p1('C', 3, 45)], 'A'), P],
  ['late joiner at 20 s', lobbyOf({ A: 1500, B: 1500, C: 1500 }), rnd([p1('A', 50), p1('B', 40), p1('C', 5, 20)], 'A'), P],
  ['AFK time', new Map(), rnd([p1('A', 50), p2('B', 2, [[0, 100]], 40, 75), p2('C', 30, [[0, 300]], 300, 150)]), P],
  ['tied kills', lobbyOf({ A: 1500, B: 1500 }), rnd([p1('A', 30), p1('B', 30)]), P],
  ['0-0 pairs', lobbyOf({ A: 1500, B: 1500, C: 1500 }), rnd([p1('A', 50), p1('B', 0), p1('C', 0)], 'A'), P],
  ['nobody scores', new Map(), rnd([p1('A', 0), p1('B', 0)]), P],
  ['two players', lobbyOf({ A: 1550, B: 1450 }), rnd([p1('A', 50), p1('B', 41)], 'A'), P],
  ['winner B', lobbyOf({ A: 1700, B: 1450, C: 1500 }), rnd([p1('A', 10), p1('B', 50), p1('C', 30)], 'B'), P],
  ['rejoin', lobbyOf({ A: 1500, B: 1500 }), rnd([p2('A', 20, [[200, 300], [0, 100]], 200), p2('B', 45, [[0, 300]], 400)]), P],
  ['never together', new Map(), rnd([p2('A', 20, [[0, 100]], 200), p2('B', 25, [[150, 300]], 300), p1('C', 50)], 'C'), P],
  ['v1 pro-rating', new Map(), rnd([p1('A', 30, 120), p1('B', 50)]), P],
  ['surprise cap', lobbyOf({ A: 1800, B: 1500, C: 1500 }), rnd([p1('A', 0), p1('B', 50), p1('C', 45)], 'B'), P],
  ['no surprise cap', lobbyOf({ A: 1800, B: 1500, C: 1500 }), rnd([p1('A', 0), p1('B', 50), p1('C', 45)], 'B'), withSettings({ surpriseCap: null })],
  ['effort: idler', lobbyOf({ A: 1500, B: 1500, Z: 1500 }),
    rnd([p2('A', 50, [[0, 300]], 400), p2('B', 30, [[0, 300]], 300), p2('Z', 0, [[0, 300]], 9)], 'A'), P],
  ['effort: just enough', new Map(), rnd([p2('A', 50, [[0, 300]], 400), p2('B', 30, [[0, 300]], 300), p2('Z', 0, [[0, 300]], 10)], 'A'), P],
  ['lobby strength', lobbyOf({ A: 1600, B: 1400, C: 1900 }), rnd([p1('A', 50), p1('B', 30), p1('C', 5, 60), p1('D', 1, 10)], 'A'), P],
  ['logistic', new Map(), rnd([p1('A', 30), p1('B', 20)]), withSettings({ shareCurve: 'logistic', logisticScale: 10 })],
  ['seeded start', new Map(), rnd([p1('A', 40), p1('B', 40)]), withSettings({ start: 'seed' }), new Map([['A', 1700]])],
  ['order and unicode', lobbyOf({ zed: 1620, 'Ålice': 1480, Bob: 1550 }),
    rnd([p1('zed', 50), p1('Ålice', 44), p1('Bob', 31, 200), p2('😀', 12, [[200, 300], [0, 60]], 80), p1('bob', 0), p1('Al', 0, 100)], 'zed'), P],
  ['zero round length', new Map(), rnd([p1('A', 50), p1('B', 10)], 'A', 0), P],
  ['legacy weighting', new Map(), rnd([p1('A', 50), p1('B', 30)], 'A'), withSettings({ lobbySize: undefined })],
  ['half duel, half eight', new Map(), rnd(letters.slice(0, 8).map((n, i) => p1(n, i ? 20 : 50, i < 2 ? 300 : 150)), 'A'), P],
  ['replacement duel', lobbyOf({ A: 1500, B: 1500, C: 1500 }),
    rnd([p1('A', 50), p2('B', 20, [[0, 150]], 200), p2('C', 20, [[150, 300]], 200)], 'A'), P],
  ['retuned anchors', new Map(), rnd(letters.slice(0, 5).map((n, i) => p1(n, i ? 30 : 50)), 'A'),
    withSettings({ lobbySize: { minPlayers: 3, minWeight: 0.1, fullPlayers: 6, fullWeight: 0.8 } })],
  ['below cutoff', new Map(), rnd([p1('A', 50), p1('B', 30)], 'A'),
    withSettings({ lobbySize: { ...P.settings.lobbySize!, minPlayers: 3 } })],
];

// mulberry32
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(r: () => number, i: number): [string, Map<string, SrPlayer>, SrRound, SrParams, Map<string, number>?] {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const pool = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'Ålice', '😀', 'zed', 'Zed'];
  const n = 2 + Math.floor(r() * 11);
  const names = pool.slice().sort(() => r() - 0.5).slice(0, n);
  const length = r() < 0.05 ? 25 : Math.round((60 + r() * 340) * 100) / 100;
  const participants = names.map(name => {
    const kills = r() < 0.15 ? 0 : r() < 0.2 ? 50 : Math.floor(r() * 50);
    let intervals: [number, number][];
    const shape = r();
    if (shape < 0.4) { const present = Math.round(r() * length); intervals = [[length - present, length]]; }
    else {
      intervals = [];
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const a = Math.round(r() * length * 100) / 100, b = Math.round(r() * length * 100) / 100;
        intervals.push(r() < 0.1 ? [b, a] : [Math.min(a, b), Math.max(a, b)]); // some empty or backwards
      }
      if (r() < 0.2) intervals.push([...intervals[0]] as [number, number]); // a duplicate
    }
    const span = intervals.reduce((t, [a, b]) => t + Math.max(0, b - a), 0);
    const present = r() < 0.8 ? span : Math.round(r() * length);
    const afk = r() < 0.3 ? Math.round(r() * present * 50) / 100 : 0;
    const shots = shape < 0.4 ? null : r() < 0.15 ? Math.floor(r() * 5) : Math.floor(r() * 200);
    return { name, kills, present, afk, shots, intervals };
  });
  const winner = r() < 0.6 ? pick(names) : r() < 0.5 ? null : 'Nobody';
  const state = new Map<string, SrPlayer>();
  for (const name of names) if (r() < 0.6) {
    state.set(name, { sr: 1200 + r() * 600, uncertainty: 30 + r() * 320, ratedWeight: r() * 50, fullRounds: Math.floor(r() * 50), lastRatedAt: null });
  }
  const params = withSettings({
    shareCurve: r() < 0.3 ? 'logistic' : 'raw', logisticScale: 5 + r() * 10,
    surpriseCap: r() < 0.3 ? null : 0.1 + r() * 0.3, m: 2 + r() * 10,
    rd0: 100 + r() * 250, rdMin: 20 + r() * 40, start: r() < 0.2 ? 'seed' : 'default',
    lobbySize: r() < 0.15 ? undefined : { minPlayers: 2 + Math.floor(r() * 2), minWeight: 0.01 + r() * 0.2,
      fullPlayers: 6 + Math.floor(r() * 4), fullWeight: 0.5 + r() * 0.5 },
  }, { d: 200 + r() * 300, beta: r() * 0.2 });
  const seed = params.settings.start === 'seed'
    ? new Map(names.filter(() => r() < 0.5).map(name => [name, 1300 + r() * 400] as [string, number])) : undefined;
  return [`random ${i}`, state, { id: `x${i}`, playedAt: '2026-10-01T12:00:00Z', length, winner, participants }, params, seed];
}

const paramsRow = (p: SrParams) => [p.version, p.d, p.beta, JSON.stringify(p.settings)];
const PARAMS_SQL = 'row($1::int, $2::float8, $3::float8, $4::jsonb, false, null, now())::public.rating_params';

function scoringCase(r: () => number, i: number): ReturnType<typeof randomCase> {
  const result = randomCase(r, i);
  const round = result[2];
  for (const p of round.participants) {
    p.intervals = normaliseIntervals(p.intervals);
    p.present = p.intervals.reduce((sum, [a, b]) => sum + b - a, 0);
    p.afk = Math.min(p.afk, p.present);
    if (!p.present) p.kills = 0;
    const loss = p.present && r() < 0.3 ? 2 : 0;
    const count = p.kills + loss;
    p.scoreEvents = Array.from({ length: count }, (_, k) => {
      let remaining = (k + 1) * p.present / (count + 1), at = 0;
      for (const [a, b] of p.intervals) {
        if (remaining <= b - a) { at = a + remaining; break; }
        remaining -= b - a;
      }
      return { at, delta: loss && k === count - 1 ? -1 : 1 };
    });
  }
  result[0] = `scoring random ${i}`;
  result[3] = { ...result[3], settings: { ...result[3].settings, rollingEvidenceKills: 25 + Math.floor(r() * 75) } };
  return result;
}

test('lobby migration re-rates existing history; curve retunes replay and version 1 remains usable', async () => {
  let before: any[] = [];
  const { db, read, assertMatchesScratch } = await setup(undefined, async db => {
    await db.exec(`insert into public.players(name, matches, elo) values ('Alice',0,'-'),('Bob',0,'-');
      insert into public.player_matches(player_name, score, time_in_lobby, total_match_time, played_at, match_id)
      values ('Alice',50,300,300,'2026-10-01','00000000-0000-0000-0000-000000000901'),
        ('Bob',30,300,300,'2026-10-01','00000000-0000-0000-0000-000000000901');`);
    before = (await db.query<any>('select * from public.rating_events order by player_name')).rows;
    assert.equal(before.length, 2);
    assert.ok(before.every(e => e.params_version === 1 && e.weight === 1));
  });
  try {
    const after = await read('select * from public.rating_events order by player_name');
    assert.equal(after.length, 2);
    assert.ok(after.every(e => e.params_version === 3));
    near(after[0].weight, 0.05, 'duel evidence');
    assert.ok(after[0].sr_after - after[0].sr_before < (before[0].sr_after - before[0].sr_before) / 5);
    await assertMatchesScratch();
    const changed = { minPlayers: 2, minWeight: 0.1, fullPlayers: 6, fullWeight: 0.8 };
    await db.query("update public.rating_params set settings = jsonb_set(settings, '{lobbySize}', $1::jsonb) where active", [JSON.stringify(changed)]);
    const retuned = await read('select * from public.rating_events order by player_name');
    near(retuned[0].weight, 0.1, 'retuned duel evidence');
    assert.ok(retuned[0].sr_after > after[0].sr_after);
    await assertMatchesScratch();
    for (const curve of [null, {}, { ...changed, minPlayers: 1 }, { ...changed, minPlayers: 2.5 },
      { ...changed, fullPlayers: 2 }, { ...changed, minWeight: 0 }, { ...changed, fullWeight: 0.01 },
      { ...changed, minWeight: '0.1' }, { ...changed, fullWeight: 2 }]) {
      await assert.rejects(db.query("update public.rating_params set settings = jsonb_set(settings, '{lobbySize}', $1::jsonb) where active",
        [JSON.stringify(curve)]), /invalid_lobby_size/);
    }
    assert.deepEqual(await read('select * from public.rating_events order by player_name'), retuned);
    await db.exec('update public.rating_params set active = false where active; update public.rating_params set active = true where version = 1;');
    const restored = await read('select * from public.rating_events order by player_name');
    assert.ok(restored.every(e => e.params_version === 1 && e.weight === 1));
    for (let i = 0; i < restored.length; i++) near(restored[i].sr_after, before[i].sr_after, 'restored legacy SR');
    await assertMatchesScratch();
  } finally { await db.close(); }
});

test('SQL curve matches the reference anchors, ceiling and validation', async () => {
  const { db } = await setup();
  try {
    for (const curve of [P.settings.lobbySize!, { minPlayers: 3, minWeight: 0.1, fullPlayers: 6, fullWeight: 0.8 }]) {
      for (let n = 0; n <= 14; n++) {
        const rows = (await db.query<any>('select public._sr_lobby_size_weight($1, $2) as w', [n, JSON.stringify({ lobbySize: curve })])).rows;
        near(rows[0].w, lobbySizeWeight(n, curve), `curve ${n}`);
      }
    }
  } finally { await db.close(); }
});

const scoringLog = (offset: number, count = 8) => {
  const length = offset + 240;
  const players = Array.from({ length: count }, (_, i) => ({ session: i + 1, name: `Timed${i}`, kills: i ? 25 : 50 }));
  const events = players.flatMap(p => Array.from({ length: p.kills }, (_, i) => ({
    session: p.session, at: offset + (i + 1) * 240 / (p.kills + (p.session === 1 ? 0 : 1)), score: i + 1,
  }))).sort((a, b) => a.at - b.at || a.session - b.session);
  return `#V,3,3.6.0\n#R,${length},Timed0\n` + players.map(p =>
    `#P,${p.session},${p.name},${p.session - 1},${p.session === 1 ? 0 : offset},${length},0,${p.kills},10,500,50,0,${p.session === 1 ? offset : 0}`).join('\n') +
    '\n' + events.map(e => `#S,${e.session},${e.at},${e.score}`).join('\n');
};

test('v3 import, rolling replay, corrections, identity and moderation agree with the reference', async () => {
  const s = await setup();
  const { db, round: prepare, upload, inputs, ratings, assertMatchesScratch, versions, roundsRewritten } = s;
  try {
    const prepared = await Promise.all([prepare(scoringLog(0), '2026-11-01T00:00:00'), prepare(scoringLog(1800), '2026-11-02T00:00:00')]);
    const ids = await upload(...prepared);
    const assembled = await inputs();
    const rounds = ids.map(id => assembled.find(r => r.match_id === id).round as SrRound);
    for (const round of rounds) for (const p of round.participants) {
      assert.ok(Array.isArray(p.scoreEvents));
      assert.equal(p.scoreEvents!.reduce((sum, e) => sum + e.delta, 0), p.kills);
    }
    const pure = await Promise.all(rounds.map(r => db.query<any>(`select public._sr_rate_round_json(${PARAMS_SQL},$5,'{}') as r`,
      [...paramsRow(P), JSON.stringify(r)])));
    const first = pure[0].rows[0].r.events, delayed = pure[1].rows[0].r.events;
    for (let i = 0; i < first.length; i++) for (const key of ['srAfter', 'uncertaintyAfter', 'weight', 'actualShare']) {
      near(first[i][key], delayed[i][key], `waiting invariant ${key}`);
    }
    near(delayed[0].weight, 1, 'late full-size winning contest');
    for (let i = 0; i < rounds.length; i++) assertSameRound(rateRound(new Map(), rounds[i], P), pure[i].rows[0].r, 'timed import');
    await assertMatchesScratch();
    const before = await versions();
    await db.query(`update public.player_sessions set score_events = jsonb_set(score_events,'{0,at_s}','1801')
      where match_id = $1 and session_no = 1`, [ids[1]]);
    const changed = await roundsRewritten(before);
    assert.ok(changed.has(ids[1]) && !changed.has(ids[0]));
    await assertMatchesScratch();
    await db.exec("update public.players set name='Timed renamed' where name='Timed1'");
    await assertMatchesScratch();
    await db.exec("update public.players set is_banned=true where name='Timed2'");
    await assertMatchesScratch();
    await db.exec("update public.players set is_banned=false where name='Timed2'");
    await assertMatchesScratch();
    const beforeRetune = await ratings();
    await db.exec(`update public.rating_params set settings = jsonb_set(settings,'{rollingEvidenceKills}','100') where active`);
    const afterRetune = await ratings();
    assert.ok(afterRetune.events[0].weight < beforeRetune.events[0].weight);
    await assertMatchesScratch();
    for (const bad of ['0', '-1', 'null', '"50"']) {
      await assert.rejects(db.exec(`update public.rating_params set settings=jsonb_set(settings,'{rollingEvidenceKills}','${bad}') where active`), /invalid_rolling_evidence/);
    }
    await db.query('delete from public.player_matches where match_id=$1', [ids[0]]);
    await assertMatchesScratch();
  } finally { await db.close(); }
});

test('the database engine agrees with sr.ts round by round', async () => {
  const { db } = await setup();
  try {
    const r = prng(20261104);
    const cases = [...fixtures, ...Array.from({ length: 400 }, (_, i) => randomCase(r, i)),
      ...Array.from({ length: 200 }, (_, i) => scoringCase(r, i))];
    let rated = 0;
    for (const [what, state, round, params, seed] of cases) {
      const ts = rateRound(state, round, params, seed);
      const states = Object.fromEntries(state);
      const out = (await db.query<any>(`select public._sr_rate_round_json(${PARAMS_SQL}, $5, $6, $7) as r`,
        [...paramsRow(params), JSON.stringify(round), JSON.stringify(states), seed ? JSON.stringify(Object.fromEntries(seed)) : null])).rows[0].r;
      assertSameRound(ts, out, what);
      rated += ts.events.length;
    }
    assert.ok(rated > 1500, `only ${rated} events compared`);
  } finally {
    await db.close();
  }
});

test('replays agree with sr.ts on a random history; incremental and relabelled ratings equal a replay exactly', async t => {
  const s = await setup();
  const { db, read, assertMatchesScratch } = s;
  try {
    const r = prng(7);
    const players = Array.from({ length: 12 }, (_, i) => `P${String(i).padStart(2, '0')}`).concat(['Ålice', '😀']);
    await db.exec(`insert into public.players(name, matches, elo) values ${players.map(n => `('${n}', 0, '-')`).join(', ')}`);
    let id = 1_000_000;
    let roundNo = 0;
    const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
    // Writes rounds straight into the tables, as an import would.
    const insertRounds = async (count: number, start = Date.UTC(2026, 9, 1)) => {
      const pm: string[] = [], sessions: string[] = [], logs: string[] = [];
      for (let k = 0; k < count; k++) {
        const match = crypto.randomUUID();
        // Some rounds share a time; some are microseconds apart.
        const at = new Date(start + Math.floor(r() * 30) * 86400_000 + Math.floor(r() * 4) * 3600_000).toISOString()
          .replace('Z', r() < 0.3 ? `${Math.floor(r() * 1000)}Z` : 'Z').replace(/\.(\d{3})(\d*)Z/, (_, ms, us) => `.${ms}${us.padEnd(3, '0')}Z`);
        const v2 = r() < 0.5;
        const length = v2 ? Math.round((90 + r() * 300) * 100) / 100 : 90 + Math.floor(r() * 300);
        const lobby = players.slice().sort(() => r() - 0.5).slice(0, 2 + Math.floor(r() * 10));
        const winner = lobby[0];
        let session = 0;
        roundNo++;
        for (const name of lobby) {
          const kills = name === winner ? 50 : Math.floor(r() * 50);
          if (!v2) {
            const rowsOfPlayer = r() < 0.08 ? 2 : 1; // the same profile twice, as in production
            for (let x = 0; x < rowsOfPlayer; x++) {
              const time = r() < 0.7 ? length : Math.floor(r() * length);
              pm.push(`(${id++}, '${name}', '${name}', ${x ? Math.floor(kills / 3) : kills}, 10, 40, 8, 2, 0, ${time}, ${length}, 500, '${at}', '${match}', null, null, null)`);
            }
          } else {
            const pid = id++;
            const spans: [number, number][] = [];
            const a = r() < 0.6 ? 0 : Math.round(r() * length * 0.6 * 100) / 100;
            if (r() < 0.25) { // leaves and rejoins
              const leave = Math.round((a + r() * (length - a) / 2) * 100) / 100;
              const back = Math.round((leave + r() * (length - leave)) * 100) / 100;
              spans.push([a, leave], [back, length]);
            } else spans.push([a, r() < 0.8 ? length : Math.round((a + r() * (length - a)) * 100) / 100]);
            const time = spans.reduce((x, [p, q]) => x + q - p, 0);
            const afk = r() < 0.3 ? Math.round(r() * time * 0.5 * 100) / 100 : 0;
            const shots = r() < 0.1 ? Math.floor(r() * 5) : 20 + Math.floor(r() * 150);
            pm.push(`(${pid}, '${name}', '${name}', ${kills}, 10, 40, 8, 2, 0, ${Math.floor(time)}, ${Math.floor(length)}, 500, '${at}', '${match}', '${r() < 0.8 ? 'present' : 'left'}', ${afk}, ${shots})`);
            spans.forEach(([p, q], x) => sessions.push(`('${match}', ${pid}, ${++session}, '${name}', 0, ${p}, ${q}, 'present', ${x ? 0 : kills}, 0, ${x ? 0 : shots}, 0, 0, ${x ? 0 : afk})`));
          }
        }
        if (v2) logs.push(`('${hex(64)}', 2, '${match}', ${length}, ${r() < 0.9 ? `'${winner}'` : 'null'}, '')`);
      }
      await db.exec(`begin;
        insert into public.player_matches(id, player_name, logged_player_name, score, deaths, accuracy, kpm, kdr, crouches,
          time_in_lobby, total_match_time, performance_score, played_at, match_id, status, afk_seconds, shots)
          overriding system value values ${pm.join(', ')};
        ${logs.length ? `insert into public.raw_logs(sha256, format_version, match_id, round_length, winner_name, text) values ${logs.join(', ')};` : ''}
        ${sessions.length ? `insert into public.player_sessions(match_id, participation_id, session_no, logged_name, slot, start_s, end_s,
          status, kills, deaths, shots, hits, crouches, afk_seconds) values ${sessions.join(', ')};` : ''}
        commit;`);
    };

    const params = (await db.query<any>('select * from public.rating_params where active')).rows[0];
    const srParams: SrParams = { version: params.version, d: params.d, beta: params.beta, settings: params.settings };
    const compareWithTs = async () => {
      const inputs = await read('select * from public._sr_round_inputs()');
      const rounds: SrRound[] = inputs.map(i => i.round);
      const { state, results } = replay(rounds, srParams);
      const sorted = rounds.slice().sort((a, b) => timeKey(a.playedAt) - timeKey(b.playedAt) || (a.id < b.id ? -1 : 1));
      assert.deepEqual(sorted.map(x => x.id), inputs.map(i => i.match_id), 'round order');
      const events = new Map((await read('select * from public.rating_events')).map(e => [`${e.match_id}/${e.player_name}`, e]));
      const lobbies = new Map((await read('select * from public.round_ratings')).map(x => [x.match_id, x]));
      let count = 0;
      results.forEach((res, k) => {
        const id = sorted[k].id;
        const lobby = lobbies.get(id);
        assert.equal(lobby.lobby_players, res.lobby?.players ?? 0);
        if (res.lobby) {
          near(lobby.lobby_sr_mean, res.lobby.meanSr, 'lobby mean');
          near(lobby.lobby_sr_min, res.lobby.minSr, 'lobby min');
          near(lobby.lobby_sr_max, res.lobby.maxSr, 'lobby max');
        } else assert.equal(lobby.lobby_sr_mean, null);
        assert.equal(lobby.rated_players, res.events.length);
        for (const e of res.events) {
          const d = events.get(`${id}/${e.name}`);
          assert.ok(d, `event ${id}/${e.name}`);
          assert.equal(d.full_round, e.full);
          near(d.weight, e.weight, 'weight'); near(d.sr_before, e.srBefore, 'srBefore'); near(d.sr_after, e.srAfter, 'srAfter');
          near(d.uncertainty_before, e.uncertaintyBefore, 'uBefore'); near(d.uncertainty_after, e.uncertaintyAfter, 'uAfter');
          near(d.expected_share, e.expectedShare, 'expected'); near(d.actual_share, e.actualShare, 'actual');
          near(d.performance, e.performance, 'performance');
          count++;
        }
      });
      assert.equal(events.size, count);
      const ratings = await read('select * from public.player_ratings');
      assert.equal(ratings.length, state.size);
      for (const pr of ratings) {
        const st = state.get(pr.player_name)!;
        near(pr.sr, st.sr, 'sr'); near(pr.uncertainty, st.uncertainty, 'uncertainty');
        near(pr.rated_weight, st.ratedWeight, 'ratedWeight'); assert.equal(pr.full_rounds, st.fullRounds);
        assert.equal(pr.last_rated_at.getTime() * 1000, Math.floor(timeKey(st.lastRatedAt!) / 1000) * 1000);
        near(pr.cautious_sr, st.sr - srParams.settings.cautiousFactor * st.uncertainty, 'cautious');
        assert.equal(pr.placed, st.uncertainty <= srParams.settings.placementUncertainty);
      }
      return count;
    };

    await t.test('a bulk history', async () => {
      await insertRounds(150);
      assert.ok(await compareWithTs() > 500);
      await assertMatchesScratch();
    });
    await t.test('rounds added one at a time, in and out of order', async () => {
      for (let k = 0; k < 12; k++) await insertRounds(1);
      await compareWithTs();
      await assertMatchesScratch();
    });
    await t.test('a rename relabels exactly', async () => {
      await db.exec("update public.players set name = 'P03 renamed' where name = 'P03'");
      await compareWithTs();
      await assertMatchesScratch();
    });
    await t.test('a ban and an unban', async () => {
      await db.exec("update public.players set is_banned = true where name = 'P05'");
      await compareWithTs();
      await assertMatchesScratch();
      await db.exec("update public.players set is_banned = false where name = 'P05'");
      await compareWithTs();
      await assertMatchesScratch();
    });
  } finally {
    await db.close();
  }
});

test('v4 log import makes phased AFK equivalent to leaving in SQL and reference, with replay and fallback intact', async () => {
  const s = await setup();
  const { db, round: prepare, upload, inputs, assertMatchesScratch, versions, roundsRewritten } = s;
  try {
    const log = (afk: boolean) => {
      const ps = ['DuelA','DuelB',...Array.from({length:6},(_,i)=>`Resident${i}`)];
      const events = ps.slice(0,2).flatMap((_,i) => Array.from({length:i?40:50},(_,j) =>
        ({session:i+1,at:(j+1)*105/(i?41:50),score:j+1}))).sort((a,b)=>a.at-b.at||a.session-b.session);
      return '#V,4,3.7.0\n#R,105,DuelA\n'+ps.map((name,i)=>
        `#P,${i+1},${name},${i},0,${i<2||afk?105:45},${i<2||afk?0:1},${i===0?50:i===1?40:0},0,100,0,0,${i>=2&&afk?60:0}`).join('\n')+
        '\n'+events.map(e=>`#S,${e.session},${e.at},${e.score}`).join('\n')+
        (afk?'\n'+ps.slice(2).map((_,i)=>`#A,${i+3},45,105,1`).join('\n'):'');
    };
    const ids = await upload(await prepare(log(false),'2026-11-03T00:00:00'),await prepare(log(true),'2026-11-04T00:00:00'));
    const rounds = (await inputs()).filter(r=>ids.includes(r.match_id)).map(r=>r.round as SrRound);
    const pure = [];
    for (const r of rounds) {
      const result = (await db.query<any>(`select public._sr_rate_round_json(${PARAMS_SQL},$5,'{}') as r`,[...paramsRow(P),JSON.stringify(r)])).rows[0].r;
      assertSameRound(rateRound(new Map(),r,P),result,'v4 import'); pure.push(result);
    }
    assert.deepEqual(pure[0],pure[1]);
    assert.equal(rounds[1].participants[2].present,105);
    assert.equal(rounds[1].participants[2].afk,60);
    assert.deepEqual(rounds[1].participants[2].afkIntervals,[{start:45,end:105,terminal:true}]);
    // Exact winning timestamp: terminal AFK points exclude the player, while
    // zero-duration actual returns are empty and retain the winning event.
    const boundaries: any[] = [];
    for (const terminal of [false,true]) {
      const boundary: SrRound = structuredClone(rounds[0]);
      boundary.participants[2].intervals=[[0,105]]; boundary.participants[2].present=105;
      boundary.participants[2].afkIntervals=[{start:105,end:105,terminal}];
      const actual = (await db.query<any>(`select public._sr_rate_round_json(${PARAMS_SQL},$5,'{}') as r`,
        [...paramsRow(P),JSON.stringify(boundary)])).rows[0].r;
      assertSameRound(rateRound(new Map(),boundary,P),actual,'terminal point');
      boundaries.push(actual);
    }
    assert.ok(boundaries[0].events[0].weight > boundaries[1].events[0].weight);
    const pb = (await db.query<any>("select personal_best_time::float as pb from public.players where name='DuelA'")).rows[0].pb;
    assert.equal(pb,105);
    assert.equal((await db.query<any>('select public._round_winning_session($1) as n',[ids[1]])).rows[0].n,1);
    await assertMatchesScratch();
    // A format correction retains stored nonempty breaks but v3 must ignore
    // them consistently in real replay, SQL JSON inputs and the TS reference.
    for (const format of [3,4]) {
      await db.query('update public.raw_logs set format_version=$1 where match_id=$2',[format,ids[1]]);
      const assembled = (await inputs()).map(i=>i.round as SrRound);
      const changed = assembled.find(r=>r.id===ids[1])!;
      assert.deepEqual(changed.participants[2].afkIntervals,format===4 ? [{start:45,end:105,terminal:true}] : undefined);
      assert.deepEqual((await db.query<any>("select public._sr_afk_intervals($1,array['Resident0']) as periods",[ids[1]])).rows[0].periods,
        format===4 ? [[{start:45,end:105,terminal:true}]] : [[]]);
      const expected = replay(assembled,P).results;
      const actual = await s.read('select * from public.rating_events');
      expected.forEach((result,i)=> {
        for (const e of result.events) {
          const stored = actual.find(r=>r.match_id===assembled[i].id && r.player_name===e.name);
          assert.ok(stored);
          near(stored.sr_after,e.srAfter,'format-correction replay SR');
          near(stored.weight,e.weight,'format-correction replay weight');
          near(stored.actual_share,e.actualShare,'format-correction replay share');
        }
      });
      assert.equal(actual.length,expected.reduce((n,r)=>n+r.events.length,0));
      await assertMatchesScratch();
    }
    // Move one break while keeping its total; all later ratings replay.
    const before = await versions();
    await db.query(`update public.player_sessions set afk_intervals='[{"start_s":30,"end_s":90,"terminal":false}]'
      where match_id=$1 and session_no=3`,[ids[1]]);
    assert.ok((await roundsRewritten(before)).has(ids[1]));
    await assertMatchesScratch();
    await assert.rejects(db.query(`update public.player_sessions set afk_intervals='[]' where match_id=$1 and session_no=3`,[ids[1]]),/valid_afk_intervals/);
    await db.query(`update public.player_sessions set afk_intervals='[]',afk_seconds=0 where match_id=$1 and session_no=3`,[ids[1]]);
    await assertMatchesScratch();
    const corrected = (await inputs()).find(r=>r.match_id===ids[1]).round as SrRound;
    assert.equal(corrected.participants[2].present,105);
    assert.equal(corrected.participants[2].afk,0); // participation cache still says 60
    assert.deepEqual(corrected.participants[2].afkIntervals,[]);
    assert.equal(rateRound(new Map(),corrected,P).excluded.some(e=>e.name==='Resident0'),false);
    // Configured time fallback consumes active spans without a second AFK subtraction.
    await db.exec("update public.rating_params set settings=settings-'rollingEvidenceKills'-'rollingMinShots' where active");
    await assertMatchesScratch();
    await db.exec("update public.players set name='Resident renamed' where name='Resident0'");
    await assertMatchesScratch();
    await db.exec("update public.players set is_banned=true where name='Resident1'");
    await assertMatchesScratch();
    await db.query('delete from public.player_matches where match_id=$1',[ids[1]]);
    await assertMatchesScratch();
  } finally { await db.close(); }
});
