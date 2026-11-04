import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Papa from 'papaparse';
import { normalizeMatchLog } from '../supabase/functions/upload-csv/parser.ts';
import { prepareRound, type PreparedRound } from '../supabase/functions/_shared/log-ingest.ts';
import { buildMatchImport, type ImportPlayer } from '../supabase/functions/_shared/import-stats.ts';

const actor = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const rows = (text: string) => Papa.parse<string[]>(normalizeMatchLog(text), {
  delimiter: ',', header: false, skipEmptyLines: 'greedy' }).data;
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

async function setup() {
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
  `);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
    await db.exec(await migration(name));
  }

  let files = 0;
  const round = (text: string, playedAt: string) => {
    files++;
    // A unique comment-free variant keeps each file's hash distinct.
    const body = text.startsWith('#V') ? text.replace('#V,2,3.5.0', `#V,2,3.5.0-${files}`) : `${text}\nUnknown,${files},0,0,0,0,0,0,0`;
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
    events: (await db.query<any>(`select * from public.rating_events order by played_at, match_id::text, player_name`)).rows,
    players: (await db.query<any>('select * from public.player_ratings order by player_name')).rows,
    rounds: (await db.query<any>('select * from public.round_ratings order by played_at, match_id::text')).rows,
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
  return { db, round, upload, asAdmin, inputs, ratings, versions, roundsRewritten, assertMatchesScratch };
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
    const params = (await db.query<any>('select version, active, settings from public.rating_params')).rows;
    assert.deepEqual(params.map(p => [p.version, p.active, p.settings.placeholder]), [[1, true, true]]);
    await assert.rejects(db.exec("insert into public.rating_params(version,d,beta,active) values (2,400,0.1,true)"), /rating_params_one_active/);
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
  const { db, round, upload, asAdmin, ratings, versions, roundsRewritten, assertMatchesScratch } = s;
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
      assert.equal(alice.rated_rounds, 7);
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
      await db.exec(`update public.rating_params set active = false where version = 1;
        insert into public.rating_params (version, d, beta, settings, active)
        select 2, 300, beta, settings || '{"standin_k": 16}', true from public.rating_params where version = 1;`);
      const r = await ratings();
      assert.ok(r.events.length > 0 && r.events.every(e => e.params_version === 2));
      assert.ok(r.rounds.every(x => x.params_version === 2));
      await assertMatchesScratch();
      await db.exec('update public.rating_params set active = false where version = 2');
      assert.deepEqual(await ratings(), { events: [], players: [], rounds: [] });
      await db.exec('update public.rating_params set active = true where version = 2');
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
      const saved = (await db.query<any>(
        "select pg_get_functiondef('public._sr_rate_round(public.rating_params,jsonb,jsonb)'::regprocedure) as d")).rows[0].d;
      await db.exec(`create or replace function public._sr_rate_round(p_params public.rating_params, p_round jsonb, p_states jsonb)
        returns jsonb language plpgsql as $$ begin raise exception 'engine failed'; end $$;`);
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

    await t.test('a reset clears every rating', async () => {
      await asAdmin("select public.reset_leaderboard('RESET')");
      assert.deepEqual(await ratings(), { events: [], players: [], rounds: [] });
    });
  } finally {
    await db.close();
  }
});
