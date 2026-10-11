import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { calculateRating } from "../supabase/functions/_shared/rating.ts";
import { rankPlayers } from "../supabase/functions/_shared/leaderboard.ts";

test("rating migration updates existing scores atomically and preserves player data", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create table public.players (
        name text primary key, user_id uuid, is_admin boolean, avatar_url text,
        bnet_accounts jsonb, matches integer, score integer, deaths integer, kdr text,
        accuracy text, kpm text, crouches integer, time_in_lobby numeric, elo text,
        rank integer, tag text
      );
      create table public.player_matches (
        id bigint generated always as identity primary key, player_name text,
        score integer, deaths integer, accuracy double precision, kpm double precision,
        kdr double precision, crouches integer, time_in_lobby numeric,
        total_match_time integer, performance_score integer
      );
      create table public.player_history (
        id bigint generated always as identity primary key, player_name text, elo integer, rank integer
      );
      create table public.audit_logs (
        id bigint generated always as identity primary key, action text, admin_user text, details text
      );
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261005210000_admin_leaderboard_reset.sql", import.meta.url), "utf8"));
    const cases = [
      { name: "Pace", kpm: 20, accuracy: 30, kdr: 1 },
      { name: "Tank", kpm: 8, accuracy: 60, kdr: 10 },
      { name: "Tie A", kpm: 16.67, accuracy: 60, kdr: 3 },
      { name: "Tie B", kpm: 16.67, accuracy: 60, kdr: 3 },
      { name: "Capped", kpm: 100, accuracy: 100, kdr: 100 },
      { name: "Sample", kpm: 11.04, accuracy: 43.9, kdr: 2.78 },
    ];
    for (const stats of cases) {
      await db.query(`insert into public.players
        (name, is_admin, avatar_url, bnet_accounts, matches, score, deaths, kdr,
          accuracy, kpm, crouches, time_in_lobby, elo, rank, tag)
        values ($1, true, 'avatar', '["BattleName"]', 2, 50, 20, $2, $3, $4, 100, 300, '9,999', 1, 'PRO')`,
        [stats.name, String(stats.kdr), `${stats.accuracy}%`, String(stats.kpm)]);
      await db.query(`insert into public.player_matches
        (player_name, score, deaths, accuracy, kpm, kdr, time_in_lobby, total_match_time, performance_score)
        values ($1, 50, 20, $2, $3, $4, 169, 271, 9999)`,
        [stats.name, stats.accuracy, stats.kpm, stats.kdr]);
    }
    await db.exec(`
      insert into public.players (name, matches, elo, rank, tag, kdr, accuracy, kpm)
        values ('New account', 0, '-', 999999, '', '-', '-', '-');
      insert into public.player_history (player_name, elo, rank) values ('Pace', 9999, 1);
    `);
    const preservedFields = "name, user_id, is_admin, avatar_url, bnet_accounts, matches, score, deaths, kdr, accuracy, kpm, crouches, time_in_lobby";
    const before = (await db.query(`select ${preservedFields} from public.players order by name`)).rows;
    const matchFields = "id, player_name, score, deaths, accuracy, kpm, kdr, time_in_lobby, total_match_time";
    const matchesBefore = (await db.query(`select ${matchFields} from public.player_matches order by id`)).rows;
    const migration = await readFile(new URL("../supabase/migrations/20261007120000_update_rating_formula.sql", import.meta.url), "utf8");
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ["players", "player_matches", "player_history", "leaderboard_state", "audit_logs"]) {
        rows[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return rows;
    };
    const originalSnapshot = await snapshot();
    await db.exec(`
      create function public.reject_rating_audit() returns trigger language plpgsql as
        $$ begin raise exception 'Rating audit rejected'; end $$;
      create trigger reject_rating_audit before insert on public.audit_logs
        for each row execute function public.reject_rating_audit();
    `);
    await assert.rejects(db.exec(migration), /Rating audit rejected/);
    await db.exec("rollback");
    assert.deepEqual(await snapshot(), originalSnapshot);
    await db.exec("drop trigger reject_rating_audit on public.audit_logs");
    await db.exec(migration);

    assert.deepEqual((await db.query(`select ${preservedFields} from public.players order by name`)).rows, before);
    assert.deepEqual((await db.query(`select ${matchFields} from public.player_matches order by id`)).rows, matchesBefore);
    const expected = rankPlayers(cases.map((stats) => ({ name: stats.name, elo: calculateRating(stats) })));
    const players = (await db.query<{ name: string; elo: string; rank: number; tag: string }>("select name, elo, rank, tag from public.players where matches > 0 order by rank")).rows;
    assert.deepEqual(players, expected.map((player) => ({ ...player,
      elo: player.elo.toLocaleString("en-US"), tag: player.elo >= 1200 ? "PRO" : "" })));
    assert.deepEqual((await db.query("select elo, rank, tag from public.players where matches = 0")).rows,
      [{ elo: "-", rank: 999999, tag: "" }]);
    const matchScores = (await db.query<{ player_name: string; performance_score: number }>("select player_name, performance_score from public.player_matches order by id")).rows;
    assert.deepEqual(matchScores, cases.map((stats) => ({ player_name: stats.name, performance_score: calculateRating(stats) })));
    assert.equal(Number((await db.query<{ revision: number }>("select revision from public.leaderboard_state")).rows[0].revision), 1);
    assert.deepEqual((await db.query("select player_name, elo, rank from public.player_history where id = 1")).rows,
      [{ player_name: "Pace", elo: 9999, rank: 1 }]);
    const history = (await db.query("select * from public.player_history order by id")).rows;
    assert.equal(history.length, cases.length + 1);

    await db.exec("set role service_role");
    await assert.rejects(db.query("select public.apply_match_import(0, '[]', '[]', '[]', '[]', 'TEST', 'Stale upload')"),
      (error: any) => error.code === "40001");
    await db.exec("reset role");
    await db.exec(migration);
    assert.deepEqual((await db.query("select * from public.player_history order by id")).rows, history);
  } finally {
    await db.close();
  }
});
