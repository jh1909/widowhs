import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Papa from 'papaparse';
import { isV2Log, normalizeMatchLog, parseV2Rows } from '../supabase/functions/upload-csv/parser.ts';
import { mergeSessions, prepareRound, type MatchSource, type PreparedRound } from '../supabase/functions/_shared/log-ingest.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';
import { scoreWeight } from '../supabase/functions/_shared/elo-weight.ts';

// A v2 round as the Workshop writes it: Bob leaves and rejoins, Carol is
// kicked, and the last #K line is padded with zeros.
const v2Log = `[00:05:09] #V,2,3.5.0
[00:05:09] #R,301.5,Alice
[00:05:09] #P,1,Alice,0,0,301.5,0,50,20,120,60,5,0
[00:05:09] #P,2,Bob,1,0,100,1,10,15,80,20,2,12.5
[00:05:09] #P,3,Carol,2,10.25,200,2,5,12,30,8,1,75
[00:05:09] #P,4,Bob,1,150,301.5,0,8,10,40,12,3,0
[00:05:09] #K,102,102,103,201,301,401,104,103,0,0`;

const rows = (text: string) => Papa.parse<string[]>(normalizeMatchLog(text), {
  delimiter: ',', header: false, skipEmptyLines: 'greedy' }).data;
const source = (text: string, name = 'Log-2026-11-03-20-15-00.txt'): MatchSource =>
  ({ name, text, played_at: '2026-11-03T20:15:00', host_name: 'HostPC' });

test('v2 logs are recognised by their #V line; v1 files are not', () => {
  assert.equal(isV2Log(rows(v2Log)), true);
  assert.equal(isV2Log(rows('[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271')), false);
});

test('v2 parsing reads every session and counts kill pairs', () => {
  const round = parseV2Rows(rows(v2Log));
  assert.equal(round.script_version, '3.5.0');
  assert.equal(round.round_length, 301.5);
  assert.equal(round.winner_name, 'Alice');
  assert.deepEqual(round.sessions.map(s => [s.session_no, s.logged_name, s.status]),
    [[1, 'Alice', 'present'], [2, 'Bob', 'left'], [3, 'Carol', 'kicked'], [4, 'Bob', 'present']]);
  assert.deepEqual(round.sessions[2], { session_no: 3, logged_name: 'Carol', slot: 2, start_s: 10.25, end_s: 200,
    status: 'kicked', kills: 5, deaths: 12, shots: 30, hits: 8, crouches: 1, afk_seconds: 75 });
  assert.deepEqual(round.kill_pairs.map(p => [p.killer_session_no, p.victim_session_no, p.kills]),
    [[1, 2, 2], [1, 3, 2], [2, 1, 1], [3, 1, 1], [4, 1, 1], [1, 4, 1]]);
});

test('a rejoin merges into one participation; same-name overlaps stay apart', () => {
  const matches = mergeSessions(parseV2Rows(rows(v2Log)));
  const bob = matches.find(m => m.player_name === 'Bob')!;
  assert.equal(matches.length, 3);
  assert.deepEqual({ ...bob, session_rows: bob.session_rows!.map(s => s.session_no) }, {
    player_name: 'Bob', score: 18, deaths: 25, accuracy: 26.67, kpm: 4.52, kdr: 0.72, crouches: 5,
    time_in_lobby: 251, total_match_time: 301, sessions: 2, status: 'present', shots: 120, hits: 32,
    afk_seconds: 12.5, session_rows: [2, 4],
  });
  const alice = matches.find(m => m.player_name === 'Alice')!;
  assert.equal(alice.kpm, 9.95);
  assert.equal(alice.kdr, 2.5);
  assert.equal(alice.accuracy, 50);

  const collision = mergeSessions(parseV2Rows(rows(`#V,2,3.5.0
#R,300,Dup
#P,1,Dup,0,0,300,0,50,10,100,50,0,0
#P,2,dup,1,20,200,1,5,10,20,5,0,0
#P,3,Dup,1,250,300,0,1,1,2,1,0,0`)));
  assert.deepEqual(collision.map(m => [m.player_name, m.sessions, m.score]), [['Dup', 1, 50], ['dup', 2, 6]]);
});

test('malformed v2 logs are rejected with the offending record', () => {
  const reject = (text: string, message: RegExp) => assert.throws(() => parseV2Rows(rows(text)), message);
  const head = '#V,2,3.5.0\n#R,300,Alice\n';
  const alice = '#P,1,Alice,0,0,300,0,50,10,100,50,0,0\n';
  reject(`#R,300,Alice\n#V,2,3.5.0\n${alice}`, /Record 2: #V must be the first line/);
  reject(`#V,5,5.0.0\n#R,300,Alice\n${alice}`, /unsupported log version 5/);
  reject(`#V,2,3.5.0\n${alice}`, /Missing #R line/);
  reject(head, /No match records found/);
  reject(`${head}${alice}${alice}`, /Record 4: session 1 appears twice/);
  reject(`${head}#P,1,Alice,0,0,300,3,50,10,100,50,0,0`, /Record 3: status must be 0, 1 or 2/);
  reject(`${head}#P,1,Alice,0,200,100,0,50,10,100,50,0,0`, /Record 3: session ends before it starts/);
  reject(`${head}#P,1,Alice,0,0,300,0,50,10,100,50,0`, /Record 3: expected 13 columns/);
  reject(`${head}#P,1,Alice,0,0,300,0,5.5,10,100,50,0,0`, /Record 3: invalid whole number in column 8/);
  reject(`${head}${alice}#K,102`, /Record 4: kill code 102 names an unknown session/);
  reject(`${head}${alice}Alice,50,10,60,20,5,120,149,160`, /Record 4: unexpected line Alice/);
});

test('a malformed file is still rejected whole, naming the record', async () => {
  await assert.rejects(prepareRound(source(`#V,2,3.5.0\n#R,300,Alice\n#P,1,Alice`), rows(`#V,2,3.5.0\n#R,300,Alice\n#P,1,Alice`)),
    /Record 3: expected 13 columns/);
});

const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const activePbMigration = '20261105120000_active_time_personal_bests.sql';

const v3Log = `#V,3,3.6.0
#R,300,Alice
#P,1,Alice,0,0,300,0,1,2,30,10,0,0
#P,2,Bob,1,0,300,0,1,2,30,10,0,0
#K,102,201,102,0,0,0,0,0,0,0
#S,1,20,1,2,25,1,1,30,2
#S,1,40,1,0,0,0,0,0,0`;

test('v3 retains timed score gains and losses without changing old logs', async () => {
  const parsed = parseV2Rows(rows(v3Log));
  assert.equal(parsed.format_version, 3);
  assert.deepEqual(parsed.sessions[0].score_events, [{ at_s: 20, score: 1 }, { at_s: 30, score: 2 }, { at_s: 40, score: 1 }]);
  assert.deepEqual(parsed.sessions[1].score_events, [{ at_s: 25, score: 1 }]);
  assert.equal(parseV2Rows(rows(v2Log)).sessions[0].score_events, undefined);
  const prepared = await prepareRound(source(v3Log), rows(v3Log));
  assert.equal(prepared.raw_log.format_version, 3);
  assert.deepEqual(prepared.matches[0].session_rows![0].score_events, parsed.sessions[0].score_events);
  const zero = v3Log.replace('#P,2,Bob,1,0,300,0,1,', '#P,2,Bob,1,0,300,0,0,').replace('2,25,1', '0,0,0');
  assert.deepEqual(parseV2Rows(rows(zero)).sessions[1].score_events, []);
});

test('v3 rejects incomplete, invalid or mistimed score histories', () => {
  for (const [text, message] of [
    [v3Log.replace('#S,1,40,1,0,0,0,0,0,0', ''), /do not match final score/],
    [v3Log.replace('1,20,1', '1,20,2'), /score must change by one/],
    [v3Log.replace('1,20,1', '1,301,1'), /outside its session or out of time order/],
    [v3Log.replace('2,25,1', '2,19,1'), /outside its session or out of time order/],
    [v3Log.replace('1,20,1', '99,20,1'), /outside its session/],
    [v3Log.replace('#S,1,40,1,0,0,0', '#S,1,40,1,0,1,0'), /invalid #S padding/],
    [v3Log + '\n#S,1,60', /triples/],
    [v3Log.replace('#V,3,3.6.0', '#V,2,3.5.0'), /#S requires log version 3/],
  ] as [string, RegExp][]) assert.throws(() => parseV2Rows(rows(text)), message);
});

test('v3 accepts the winning event at the cutoff and rejects post-cutoff scoring', async () => {
  const text = `#V,3,3.6.0\n#R,50,Alice\n#P,1,Alice,0,0,50,0,50,0,60,50,0,0\n` +
    Array.from({ length: 50 }, (_, i) => `#S,1,${i + 1},${i + 1}`).join('\n');
  assert.equal(parseV2Rows(rows(text)).sessions[0].score_events!.at(-1)!.score, 50);
  assert.throws(() => parseV2Rows(rows(text.replace(',0,50,0,60,', ',0,49,0,60,') + '\n#S,1,50.02,49')), /outside its session/);
  const workshop = await readFile(new URL('../workshop/widowhs.ows', import.meta.url), 'utf8');
  const rule = (name: string) => workshop.split(`rule("${name}")`)[1].split('\nrule(')[0];
  // Static contract check; Workshop syntax and event ordering still need in-game validation.
  assert.match(rule('On kill'), /conditions\s*\{\s*Global\.gameComplete == False;/);
  assert.match(rule('On death'), /If\(!Global\.gameComplete && Event Was Environment/);
  assert.match(rule('Player init'), /conditions\s*\{\s*Global\.gameComplete == False;/);
  assert.match(rule('Player init'), /If\(!Global\.gameComplete\);\s*Global\.sessionStart/);
});

test('ingest stores raw logs once, v2 sessions and kill pairs', async t => {
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
    for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
      // Exercise the PB migration's backfill below, after importing old-format
      // and session logs through the deployed importer.
      if (name !== activePbMigration) await db.exec(await migration(name));
    }

    const revision = async () => (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
    const upload = async (rounds: PreparedRound[]) => {
      const players = (await db.query<ImportPlayer>('select * from public.players')).rows;
      const payload = buildMatchImport(players, rounds.flatMap(round => round.matches));
      await db.exec('set role service_role');
      try {
        await db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','ingest',$6,$7)",
          [await revision(), ...[payload.players, payload.ranks, payload.history, payload.matches,
            rounds.map(round => round.raw_log), rounds.flatMap(round => round.kill_pairs)].map(v => JSON.stringify(v))]);
      } finally {
        await db.exec('reset role');
      }
    };
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ['players', 'player_matches', 'player_history', 'player_sessions', 'round_kill_pairs',
        'raw_logs', 'audit_logs', 'leaderboard_state']) {
        result[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return result;
    };

    const round = await prepareRound(source(v2Log), rows(v2Log));
    await t.test('a v2 round imports into the right tables, with the rejoin merged', async () => {
      await upload([round]);
      const matches = (await db.query<any>(`select id, player_name, score, deaths, time_in_lobby::float, total_match_time,
        sessions, status, shots, hits, afk_seconds::float, round(elo_weight, 4)::float as weight
        from public.player_matches order by player_name`)).rows;
      assert.deepEqual(matches.map(({ id, ...match }) => match), [
        { player_name: 'Alice', score: 50, deaths: 20, time_in_lobby: 301, total_match_time: 301, sessions: 1,
          status: 'present', shots: 120, hits: 60, afk_seconds: 0, weight: 1 },
        { player_name: 'Bob', score: 18, deaths: 25, time_in_lobby: 251, total_match_time: 301, sessions: 2,
          status: 'present', shots: 120, hits: 32, afk_seconds: 12.5, weight: 0.7924 },
        { player_name: 'Carol', score: 5, deaths: 12, time_in_lobby: 189, total_match_time: 301, sessions: 1,
          status: 'kicked', shots: 30, hits: 8, afk_seconds: 75, weight: 0.3787 },
      ]);
      const ids = Object.fromEntries(matches.map(match => [match.player_name, match.id]));
      const sessions = (await db.query<any>(`select session_no, participation_id, logged_name, status, start_s::float, end_s::float
        from public.player_sessions order by session_no`)).rows;
      assert.deepEqual(sessions, [
        { session_no: 1, participation_id: ids.Alice, logged_name: 'Alice', status: 'present', start_s: 0, end_s: 301.5 },
        { session_no: 2, participation_id: ids.Bob, logged_name: 'Bob', status: 'left', start_s: 0, end_s: 100 },
        { session_no: 3, participation_id: ids.Carol, logged_name: 'Carol', status: 'kicked', start_s: 10.25, end_s: 200 },
        { session_no: 4, participation_id: ids.Bob, logged_name: 'Bob', status: 'present', start_s: 150, end_s: 301.5 },
      ]);
      assert.deepEqual((await db.query<any>(`select killer_session_no, victim_session_no, kills from public.round_kill_pairs
        order by 1, 2`)).rows.map(p => [p.killer_session_no, p.victim_session_no, p.kills]),
        [[1, 2, 2], [1, 3, 2], [1, 4, 1], [2, 1, 1], [3, 1, 1], [4, 1, 1]]);
      const raw = (await db.query<any>('select * from public.raw_logs')).rows;
      assert.equal(raw.length, 1);
      assert.equal(raw[0].text, v2Log);
      assert.equal(raw[0].sha256, round.raw_log.sha256);
      assert.equal(raw[0].match_id, round.raw_log.match_id);
      assert.deepEqual([raw[0].filename, raw[0].host_name, raw[0].format_version, raw[0].script_version,
        Number(raw[0].round_length), raw[0].winner_name], ['Log-2026-11-03-20-15-00.txt', 'HostPC', 2, '3.5.0', 301.5, 'Alice']);
      assert.equal((await db.query<any>('select count(distinct match_id)::int as n from public.player_matches')).rows[0].n, 1);
    });

    await t.test('v3 stores validated score histories, including losses and legacy NULLs', async () => {
      const timed = await prepareRound(source(v3Log), rows(v3Log));
      await upload([timed]);
      const stored = (await db.query<any>('select session_no, score_events from public.player_sessions where match_id = $1 order by 1', [timed.raw_log.match_id])).rows;
      assert.deepEqual(stored, [{ session_no: 1, score_events: [{ at_s: 20, score: 1 }, { at_s: 30, score: 2 }, { at_s: 40, score: 1 }] },
        { session_no: 2, score_events: [{ at_s: 25, score: 1 }] }]);
      assert.equal((await db.query<any>('select format_version from public.raw_logs where match_id = $1', [timed.raw_log.match_id])).rows[0].format_version, 3);
      const before = await snapshot();
      await assert.rejects(db.query("update public.player_sessions set score_events = '[{\"at_s\":301,\"score\":1}]' where match_id = $1", [timed.raw_log.match_id]), /valid_score_events/);
      assert.deepEqual(await snapshot(), before);
      assert.ok((await db.query<any>('select score_events from public.player_sessions where match_id = $1', [round.raw_log.match_id])).rows.every(s => s.score_events === null));
      // Leave the existing fixture's aggregate counts untouched for its checks.
      await db.query('delete from public.player_matches where match_id = $1', [timed.raw_log.match_id]);
      await db.query('delete from public.raw_logs where match_id = $1', [timed.raw_log.match_id]);
    });

    await t.test('the same file uploaded twice changes nothing', async () => {
      const before = await snapshot();
      await assert.rejects(upload([await prepareRound(source(v2Log), rows(v2Log))]), (error: any) => error.code === 'PT409');
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('v1 files keep importing as before and store their raw log', async () => {
      const text = '[00:04:38] Dave,5,15,10.20,1.77,0.33,9,169,271';
      await upload([await prepareRound(source(text, 'Log-2026-11-03-21-00-00.txt'), rows(text))]);
      const dave = (await db.query<any>(`select score, accuracy::float, kpm::float, kdr::float, time_in_lobby::float,
        total_match_time, sessions, status, shots, hits, afk_seconds from public.player_matches where player_name = 'Dave'`)).rows;
      assert.deepEqual(dave, [{ score: 5, accuracy: 10.2, kpm: 1.77, kdr: 0.33, time_in_lobby: 169, total_match_time: 271,
        sessions: null, status: null, shots: null, hits: null, afk_seconds: null }]);
      const raw = (await db.query<any>("select format_version, script_version, text from public.raw_logs where filename like '%21-00-00%'")).rows;
      assert.deepEqual(raw, [{ format_version: 1, script_version: null, text }]);
      assert.equal((await db.query<any>('select count(*)::int as n from public.player_sessions')).rows[0].n, 4);
    });

    await t.test('the deployed upload-csv still works through the old seven arguments', async () => {
      const players = (await db.query<ImportPlayer>('select * from public.players')).rows;
      const legacy = await prepareRound(source('Erin,50,10,60,20,5,120,149,160', 'old.csv'), rows('Erin,50,10,60,20,5,120,149,160'));
      const payload = buildMatchImport(players, legacy.matches);
      await db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','legacy')",
        [await revision(), ...[payload.players, payload.ranks, payload.history, payload.matches].map(v => JSON.stringify(v))]);
      assert.equal((await db.query<any>("select count(*)::int as n from public.player_matches where player_name = 'Erin'")).rows[0].n, 1);
    });

    await t.test("a banned player's sessions and kill pairs are not stored", async () => {
      await db.exec("update public.players set is_banned = true where name = 'Carol'");
      const text = v2Log.replace('#V,2,3.5.0', '#V,2,3.5.0-replay');
      const replay = await prepareRound(source(text), rows(text));
      await upload([replay]);
      const sessions = (await db.query<any>('select session_no from public.player_sessions where match_id = $1 order by 1',
        [replay.raw_log.match_id])).rows.map(s => s.session_no);
      assert.deepEqual(sessions, [1, 2, 4]);
      const pairs = (await db.query<any>('select killer_session_no, victim_session_no from public.round_kill_pairs where match_id = $1',
        [replay.raw_log.match_id])).rows;
      assert.equal(pairs.length, 4);
      assert.ok(pairs.every(p => p.killer_session_no !== 3 && p.victim_session_no !== 3));
    });

    await t.test('deleting rounds removes their sessions and kill pairs but keeps raw logs', async () => {
      await db.exec('delete from public.player_matches where true');
      assert.equal((await db.query<any>('select count(*)::int as n from public.player_sessions')).rows[0].n, 0);
      assert.equal((await db.query<any>('select count(*)::int as n from public.round_kill_pairs')).rows[0].n, 0);
      assert.equal((await db.query<any>('select count(*)::int as n from public.raw_logs')).rows[0].n, 3);
    });

    await t.test('a fully AFK session counts for nothing in ELO; match details show status and AFK time', async () => {
      // Dan idles from the start: 15 s until the AFK state, then the kick 60 s later.
      const text = `#V,2,3.5.0
#R,136.02,Erin
#P,1,Dan,1,0,76.55,2,0,0,0,0,0,60.54
#P,2,Erin,0,0,136.02,0,15,1,20,15,8,31.44`;
      const afk = await prepareRound(source(text, 'Log-2026-11-04-02-41-19.txt'), rows(text));
      await upload([afk]);
      const weights = (await db.query<any>(`select player_name, round(elo_weight, 4)::float as weight, kpm::float
        from public.player_matches where match_id = $1 order by player_name`, [afk.raw_log.match_id])).rows;
      // Erin was AFK for 31.44 s of 136: weight and kills per minute count only the active seconds.
      assert.deepEqual(weights, [{ player_name: 'Dan', weight: 0, kpm: 0 },
        { player_name: 'Erin', weight: 0.7688, kpm: 8.61 }]);
      const history = (await db.query<any>("select player_name from public.player_history where player_name in ('Dan', 'Erin')")).rows;
      assert.deepEqual(history.map(h => h.player_name), ['Erin']);
      const details = (await db.query<any>('select public.get_match_details($1) as d', [afk.raw_log.match_id])).rows[0].d;
      assert.deepEqual(details.map((p: any) => [p.player_name, p.status, Number(p.afk_seconds)]),
        [['Erin', 'present', 31.44], ['Dan', 'kicked', 60.54]]);
    });

    await t.test('the SQL weight rule matches scoreWeight for v1 and v2 rows', async () => {
      for (const status of [null, 'present', 'left', 'kicked']) for (const total of [null, 136, 300])
        for (const time of [0, 29, 30, 76, 120, 179, 180, 289, 290, 300]) for (const afk of [0, 0.5, 60.54, 150])
          for (const score of [0, 14, 15, 35]) {
            const sql = Number((await db.query<any>('select public.match_elo_weight($1, $2, $3, $4, $5) as w',
              [score, time, total, status, status ? afk : null])).rows[0].w);
            const ts = scoreWeight({ score, time_in_lobby: time, total_match_time: total, status, afk_seconds: status ? afk : null });
            assert.ok(Math.abs(sql - ts) < 1e-12, `${status} ${score} ${time} ${total} ${afk}: SQL ${sql}, TS ${ts}`);
          }
    });

    await t.test('browsers cannot read raw logs, sessions or kill pairs', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        try {
          for (const table of ['raw_logs', 'player_sessions', 'round_kill_pairs']) {
            await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
          }
        } finally {
          await db.exec('reset role');
        }
      }
    });

    const pb = async (name: string) => {
      const value = (await db.query<any>('select personal_best_time from public.players where name = $1', [name])).rows[0]?.personal_best_time;
      return value == null ? null : Number(value);
    };
    const publicResults = async (match: string) => {
      await db.exec('set role anon');
      try {
        const list = (await db.query<any>('select public.get_global_matches(100, 0) as data')).rows[0].data;
        const details = (await db.query<any>('select public.get_match_details($1) as data', [match])).rows[0].data;
        return { winner: list.matches.find((r: any) => r.match_id === match)?.winner, details };
      } finally { await db.exec('reset role'); }
    };
    const timedWinText = `#V,2,3.5.0
#R,600,PBFast
#P,1,PBFast,0,100,600,0,50,10,100,50,0,350
#P,2,PBFalse,1,0,200,1,30,10,100,30,0,0
#P,3,PBFalse,1,300,600,0,30,10,100,30,0,0`;
    const timedWin = await prepareRound(source(timedWinText), rows(timedWinText));

    await t.test('active PB migration backfills real winning sessions and preserves legacy times and SR', async () => {
      const rejoinText = `#V,2,3.5.0
#R,700,PBRejoin
#P,1,PBRejoin,0,0,100,1,40,10,100,40,0,10
#P,2,PBRejoin,0,400,700,0,50,10,100,50,0,100
#P,3,PBOpp,1,0,700,0,40,10,100,40,0,0`;
      const legacyText = 'PBLegacy,50,10,50,16.67,5,0,180,600';
      await upload([timedWin, await prepareRound(source(rejoinText), rows(rejoinText)),
        await prepareRound(source(legacyText), rows(legacyText))]);
      assert.equal(await pb('PBFast'), 500);
      assert.equal(await pb('PBFalse'), 500); // The old summed-score rule falsely awards this loss.
      assert.equal(await pb('PBRejoin'), 400);
      const hasSr = (await db.query<any>("select to_regclass('public.rating_events') is not null as present")).rows[0].present;
      const srBefore = hasSr ? (await db.query('select * from public.rating_events order by match_id, player_name')).rows : null;
      const statsBefore = (await db.query('select id, score, time_in_lobby, afk_seconds, kpm, elo_weight from public.player_matches order by id')).rows;
      await db.exec(await migration(activePbMigration));
      // The fixture deliberately delayed PBs to exercise their legacy backfill.
      // Apply the actual v4 helper extension after that prerequisite, as deployed.
      const afkMigration = await migration('20261105130000_afk_intervals.sql');
      await db.exec(afkMigration.slice(afkMigration.indexOf('-- Extend all PR #2'), afkMigration.indexOf("notify pgrst")));
      assert.equal(await pb('PBFast'), 150);
      assert.equal(await pb('PBFalse'), null);
      assert.equal(await pb('PBRejoin'), 200); // Only the final 0–50 session, minus its AFK.
      assert.equal(await pb('PBLegacy'), 180);
      if (hasSr) assert.deepEqual((await db.query('select * from public.rating_events order by match_id, player_name')).rows, srBefore);
      assert.deepEqual((await db.query('select id, score, time_in_lobby, afk_seconds, kpm, elo_weight from public.player_matches order by id')).rows, statsBefore);
    });

    await t.test('public results identify the logged winner instead of a losing summed rejoin score', async () => {
      const result = await publicResults(timedWin.raw_log.match_id);
      assert.equal(result.winner, 'PBFast');
      assert.deepEqual(result.details.map((p: any) => [p.player_name, p.score, p.is_winner]),
        [['PBFast', 50, true], ['PBFalse', 60, false]]);
      for (const p of result.details) for (const key of ['session_rows', 'score_events', 'user_id', 'bnet_accounts'])
        assert.equal(key in p, false);
      const legacy = (await db.query<any>("select match_id from public.player_matches where player_name = 'PBLegacy'")).rows[0].match_id;
      assert.equal((await publicResults(legacy)).winner, 'PBLegacy');
      assert.equal((await publicResults(legacy)).details[0].is_winner, true);
    });

    await t.test('PB follows session/round corrections, deletions and later imports', async () => {
      const match = timedWin.raw_log.match_id;
      await db.query('update public.player_sessions set afk_seconds = 250 where match_id = $1 and session_no = 1', [match]);
      assert.equal(await pb('PBFast'), 250);
      await db.query('update public.player_sessions set start_s = 150 where match_id = $1 and session_no = 1', [match]);
      assert.equal(await pb('PBFast'), 200);
      await db.query("update public.raw_logs set winner_name = 'PBFalse' where match_id = $1", [match]);
      assert.equal(await pb('PBFast'), null);
      assert.equal(await pb('PBFalse'), null); // Neither of the two 30-kill sessions won.
      assert.equal((await publicResults(match)).winner, null);
      assert.ok((await publicResults(match)).details.every((p: any) => !p.is_winner));
      await db.query("update public.raw_logs set winner_name = 'PBFast' where match_id = $1", [match]);
      assert.equal(await pb('PBFast'), 200);
      await db.query('delete from public.player_sessions where match_id = $1 and session_no = 1', [match]);
      assert.equal(await pb('PBFast'), null);
      const text = `#V,2,3.5.0\n#R,200,PBFast\n#P,1,PBFast,0,0,200,0,50,10,100,50,0,75`;
      const round = await prepareRound(source(text), rows(text));
      await upload([round]);
      assert.equal(await pb('PBFast'), 125);
      await db.query('delete from public.raw_logs where match_id = $1', [round.raw_log.match_id]);
      assert.equal(await pb('PBFast'), null); // No fallback to a session row's elapsed time.
      assert.equal((await publicResults(round.raw_log.match_id)).winner, null);
      assert.ok((await publicResults(round.raw_log.match_id)).details.every((p: any) => !p.is_winner));
    });

    await t.test('session PBs survive profile transfers and cannot be forged by clients', async () => {
      await db.query("update public.player_matches set player_name = 'PBLegacy' where player_name = 'PBRejoin'");
      assert.equal(await pb('PBRejoin'), null);
      assert.equal(await pb('PBLegacy'), 180);
      await db.query("update public.player_matches set player_name = 'PBRejoin' where logged_player_name = 'PBRejoin'");
      assert.equal(await pb('PBRejoin'), 200);
      await db.query("update public.players set personal_best_time = 1 where name = 'PBRejoin'");
      assert.equal(await pb('PBRejoin'), 200);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(db.query("select public._player_personal_best('PBRejoin')"), /permission denied/);
          await assert.rejects(db.query('select public._round_winning_session($1)', [timedWin.raw_log.match_id]), /permission denied/);
        } finally { await db.exec('reset role'); }
      }
    });

    await t.test('v4 intervals persist through the importer and database validation rejects inconsistent corrections', async () => {
      const text = `#V,4,3.7.0
#R,180,AFKStored
#P,1,AFKStored,0,0,180,0,50,0,50,50,0,40
#P,2,AFKEmpty,1,0,180,0,0,0,20,0,0,0
#A,1,60,100,0` + '\n' + Array.from({length:50},(_,i)=>`#S,1,${101+i},${i+1}`).join('\n');
      const prepared = await prepareRound(source(text), rows(text));
      await upload([prepared]);
      assert.equal(await pb('AFKStored'),140);
      assert.equal((await db.query<any>('select public._round_winning_session($1) as n',[prepared.raw_log.match_id])).rows[0].n,1);
      const periods = (await db.query<any>('select afk_intervals from public.player_sessions where match_id=$1 order by session_no',
        [prepared.raw_log.match_id])).rows;
      assert.deepEqual(periods.map(s => s.afk_intervals), [[{start_s:60,end_s:100,terminal:false}],[]]);
      for (const invalid of [[], [{start_s:50,end_s:90,terminal:true}],
        [{start_s:60,end_s:100,terminal:false},{start_s:90,end_s:100,terminal:false}],
        [{start_s:-1,end_s:39,terminal:false}], [{start_s:60,end_s:100}], {start_s:60,end_s:100}]) {
        await assert.rejects(db.query('update public.player_sessions set afk_intervals=$1 where match_id=$2 and session_no=1',
          [JSON.stringify(invalid),prepared.raw_log.match_id]), /valid_afk_intervals/);
      }
    });

    await t.test('zero active duration and ambiguous winners cannot create PBs; fast wins need no SR eligibility', async () => {
      for (const [name, duration, afk, duplicate, expected] of [
        ['PBZero', 100, 100, false, null], ['PBAmbiguous', 100, 0, true, null], ['PBMonster', 29, 0, false, 29],
      ] as const) {
        const text = `#V,2,3.5.0\n#R,${duration},${name}\n#P,1,${name},0,0,${duration},0,50,0,50,50,0,${afk}` +
          (duplicate ? `\n#P,2,${name},1,0,${duration},0,50,0,50,50,0,0` : '');
        await upload([await prepareRound(source(text), rows(text))]);
        assert.equal(await pb(name), expected);
      }
    });
  } finally {
    await db.close();
  }
});

test('v4 AFK breaks retain repeats, leavers, kicks and known empty versus legacy unknown', () => {
  const log = `#V,4,3.7.0
#R,180,Alice
#P,1,Alice,0,0,180,0,0,0,20,0,0,50
#P,2,Bob,1,0,100,1,0,0,20,0,0,40
#P,3,Carol,2,0,105,2,0,0,20,0,0,60
#P,4,Bob,1,110,180,0,0,0,20,0,0,0
#A,1,60,100,0
#A,1,170,180,1
#A,2,60,100,1
#A,3,45,105,1`;
  const parsed = parseV2Rows(rows(log));
  assert.equal(parsed.format_version, 4);
  assert.deepEqual(parsed.sessions.map(s => s.afk_intervals), [
    [{ start_s: 60, end_s: 100, terminal: false }, { start_s: 170, end_s: 180, terminal: true }],
    [{ start_s: 60, end_s: 100, terminal: true }], [{ start_s: 45, end_s: 105, terminal: true }], [],
  ]);
  assert.equal(mergeSessions(parsed).find(p => p.player_name === 'Bob')!.afk_seconds, 40);
  assert.equal(parseV2Rows(rows(v2Log)).sessions[0].afk_intervals, undefined);
  for (const [from, to] of [
    ['#A,1,170,180,1', '#A,1,90,180,1'], ['#A,2,60,100,1', '#A,2,60,101,1'],
    ['#A,3,45,105,1', '#A,3,106,105,1'], ['#A,3,45,105,1', '#A,9,45,105,1'],
    ['#A,3,45,105,1', '#A,3,NaN,105,1'], ['#A,3,45,105,1', '#A,3,45,104,1'],
    ['#A,3,45,105,1', '#A,3,45,105,1,0'],
  ]) assert.throws(() => parseV2Rows(rows(log.replace(from, to))), /AFK|number|columns/);
  assert.throws(() => parseV2Rows(rows(log.replace('#V,4', '#V,3'))), /#A requires/);
  assert.throws(() => parseV2Rows(rows(log.replace('#R,180', '#R,179'))), /outside the round/);
  assert.doesNotThrow(() => parseV2Rows(rows(log.replace(',0,0,50\n', ',0,0,50.01\n'))));
});


test('standalone v4 completeness survives omitted data, corrections, associations and later SR installation', async () => {
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
    const srMigrations = ['20261104120000_skill_rating.sql','20261104200000_sr_lobby_size.sql',
      '20261104220000_rolling_skill_rating.sql','20261105140000_afk_skill_rating.sql'];
    const installed = (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort();
    for (const name of installed) if (!srMigrations.includes(name)) await db.exec(await migration(name));
    for (const periods of [[],[{start_s:20,end_s:40,terminal:false}]]) {
      for (let missing=0;missing<3;missing++) {
        const bounds: (number|null)[]=[0,100,periods.length ? 20 : 0]; bounds[missing]=null;
        assert.equal((await db.query<any>('select public._valid_afk_intervals($1,$2,$3,$4) as valid',
          [JSON.stringify(periods),...bounds])).rows[0].valid,false);
      }
    }
    assert.equal((await db.query<any>('select public._valid_afk_intervals(null,null,null,null) as valid')).rows[0].valid,true);
    const revision = async () => (await db.query<any>('select revision from public.leaderboard_state')).rows[0].revision;
    let sequence = 0;
    const prepared = async (version = 4) => {
      sequence++;
      const text = `#V,${version},test-${sequence}\n#R,100,Complete${sequence}\n#P,1,Complete${sequence},0,0,100,0,0,0,20,0,0,0`;
      return prepareRound(source(text),rows(text));
    };
    const upload = async (round: PreparedRound) => {
      const players = (await db.query<ImportPlayer>('select * from public.players')).rows;
      const payload = buildMatchImport(players,round.matches);
      await db.exec('set role service_role');
      try {
        await db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','complete',$6,$7)",
          [await revision(),...[payload.players,payload.ranks,payload.history,payload.matches,[round.raw_log],round.kill_pairs].map(v=>JSON.stringify(v))]);
      } finally { await db.exec('reset role'); }
    };
    for (const missing of ['omitted','null']) {
      const round = await prepared();
      if (missing === 'omitted') delete round.matches[0].session_rows![0].afk_intervals;
      else (round.matches[0].session_rows![0] as any).afk_intervals=null;
      const before = await revision();
      await assert.rejects(upload(round),/v4 sessions require known AFK intervals/);
      assert.equal(await revision(),before);
      assert.equal((await db.query<any>('select count(*)::int as n from public.raw_logs')).rows[0].n,0);
    }
    const known = await prepared(), legacy = await prepared(3);
    await upload(known); await upload(legacy);
    const knownId = known.raw_log.match_id, legacyId = legacy.raw_log.match_id;
    const session = async (id: string) => (await db.query<any>('select * from public.player_sessions where match_id=$1',[id])).rows[0];
    assert.deepEqual((await session(knownId)).afk_intervals,[]);
    assert.equal((await session(legacyId)).afk_intervals,null);
    await assert.rejects(db.query('update public.player_sessions set afk_intervals=null where match_id=$1',[knownId]),/v4 sessions require/);
    await assert.rejects(db.query('update public.raw_logs set format_version=4 where match_id=$1',[legacyId]),/v4 sessions require/);
    // Both session-owned and participation-owned round associations require data.
    await assert.rejects(db.query('update public.player_sessions set match_id=$1,session_no=2 where match_id=$2',[knownId,legacyId]),/v4 sessions require/);
    await assert.rejects(db.query('update public.player_sessions set participation_id=$1 where match_id=$2',
      [(await session(knownId)).participation_id,legacyId]),/v4 sessions require/);
    await assert.rejects(db.query('update public.player_matches set match_id=$1 where match_id=$2',[knownId,legacyId]),/v4 sessions require/);
    // A session linked through a different round must still block its log upgrade.
    const detached = await prepared(3); await upload(detached);
    await db.query('update public.player_sessions set match_id=$1,session_no=2 where match_id=$2',[detached.raw_log.match_id,legacyId]);
    await assert.rejects(db.query('update public.raw_logs set format_version=4 where match_id=$1',[detached.raw_log.match_id]),/v4 sessions require/);
    await db.query('update public.player_sessions set match_id=$1,session_no=1 where participation_id=$2',
      [legacyId,(await db.query<any>('select id from public.player_matches where match_id=$1',[legacyId])).rows[0].id]);
    // Deferred checks allow either ordering within an atomic correction.
    for (const reverse of [false,true]) {
      await db.exec('begin');
      await db.query('update public.raw_logs set format_version=3 where match_id=$1',[legacyId]);
      await db.query('update public.player_sessions set afk_intervals=null where match_id=$1',[legacyId]);
      await db.exec('commit');
      await db.exec('begin');
      const format = () => db.query('update public.raw_logs set format_version=4 where match_id=$1',[legacyId]);
      const intervals = () => db.query("update public.player_sessions set afk_intervals='[]' where match_id=$1",[legacyId]);
      if (reverse) { await intervals(); await format(); } else { await format(); await intervals(); }
      await db.exec('commit');
    }
    const acl = (await db.query<any>(`select has_function_privilege('service_role','public._require_v4_afk_intervals()','execute') as allowed`)).rows[0];
    assert.equal(acl.allowed,false);
    // Deploying PR #3 after independently installed PR #2 must replay valid data.
    for (const name of srMigrations) if (installed.includes(name)) await db.exec(await migration(name));
    if (installed.includes(srMigrations[0])) {
      await db.exec('select public.replay_ratings()');
      const inputs = (await db.query<any>('select * from public._sr_round_inputs()')).rows;
      assert.deepEqual(inputs.find(r=>r.match_id===knownId).round.participants[0].afkIntervals,[]);
    }
  } finally { await db.close(); }
});
