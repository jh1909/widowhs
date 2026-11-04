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
  reject(`#V,3,4.0.0\n#R,300,Alice\n${alice}`, /unsupported log version 3/);
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
      await db.exec(await migration(name));
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

    await t.test('the same file uploaded twice changes nothing', async () => {
      const before = await snapshot();
      await assert.rejects(upload([await prepareRound(source(v2Log), rows(v2Log))]), (error: any) => error.code === '40001');
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
  } finally {
    await db.close();
  }
});
