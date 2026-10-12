import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Papa from "papaparse";
import { readMatchSources } from "../supabase/functions/_shared/match-upload.ts";
import { normalizeMatchLog, parseMatchRows } from "../supabase/functions/upload-csv/parser.ts";

test("filename match dates persist transactionally without changing upload timestamps", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create table public.players (
        name text primary key, user_id uuid, is_admin boolean default false,
        avatar_url text, matches integer, score integer, deaths integer, kdr text,
        accuracy text, kpm text, crouches integer, time_in_lobby numeric,
        elo text, rank integer, tag text
      );
      create table public.player_matches (
        id bigint generated always as identity primary key, player_name text,
        score integer, deaths integer, accuracy numeric, kpm numeric, kdr numeric,
        crouches integer, time_in_lobby numeric, total_match_time integer,
        performance_score integer, created_at timestamptz not null default now()
      );
      create table public.player_history (
        id bigint generated always as identity primary key, player_name text, elo integer, rank integer
      );
      create table public.audit_logs (
        id bigint generated always as identity primary key, action text, admin_user text, details text
      );
      insert into public.players (name, user_id, avatar_url, matches)
        values ('Alice', '00000000-0000-0000-0000-000000000001', 'discord-avatar', 1);
      insert into public.player_matches (player_name, created_at)
        values ('Alice', '2026-10-01T12:34:56Z');
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261005210000_admin_leaderboard_reset.sql", import.meta.url), "utf8"));
    const migration = await readFile(new URL("../supabase/migrations/20261012120000_add_match_date.sql", import.meta.url), "utf8");
    await db.exec(migration);
    const revision = async () => Number((await db.query<{ revision: number }>(
      "select revision from public.leaderboard_state where singleton")).rows[0].revision);
    const importMatches = async (matches: unknown[], expectedRevision?: number) => {
      const expected = expectedRevision ?? await revision();
      await db.exec("set role service_role");
      try {
        return await db.query("select public.apply_match_import($1, $2, $3, $4, $5, $6, $7)", [
          expected,
          JSON.stringify([{ name: "Alice", matches: 3, score: 100, deaths: 20, kdr: "5.00",
            accuracy: "60", kpm: "20", crouches: 2, time_in_lobby: 300, elo: "1200", rank: 1, tag: "PRO" }]),
          "[]", JSON.stringify([{ player_name: "Alice", elo: 1200, rank: 1 }]),
          JSON.stringify(matches), "TEST", "Filename date import",
        ]);
      } finally { await db.exec("reset role"); }
    };
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["players", "player_matches", "player_history", "leaderboard_state", "audit_logs"]) {
        result[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return result;
    };

    await t.test("existing matches retain their original timestamp", async () => {
      const match = (await db.query<{ played_at: Date; created_at: Date }>("select * from public.player_matches")).rows[0];
      assert.equal(new Date(match.played_at).toISOString(), "2026-10-01T12:34:56.000Z");
      assert.deepEqual(match.played_at, match.created_at);
    });

    await t.test("multi-file imports use Berlin summer/winter time and sort by match time", async () => {
      const form = new FormData();
      // Newer match deliberately uploaded first; arrival order must not determine history order.
      form.append("file", new File(["[00:02:30] Alice,50,10,60,20,5,1,150,150"], "Log-2026-10-11-20-12-49.txt"));
      form.append("file", new File(["Alice,50,10,60,20,5,1,150,150"], "Log-2026-01-11-20-12-49.csv"));
      const sources = await readMatchSources(new Request("https://example.test/upload", { method: "POST", body: form }));
      const matches = sources.flatMap((source) => parseMatchRows(Papa.parse<string[]>(
        normalizeMatchLog(source.text), { delimiter: ",", skipEmptyLines: "greedy" }).data)
        .map((match) => ({ ...match, performance_score: 1200, played_at: source.played_at })));
      const beforeRevision = await revision();
      await importMatches(matches);
      const rows = (await db.query<{ played_at: Date; created_at: Date }>(
        "select played_at, created_at from public.player_matches order by played_at desc, created_at desc")).rows;
      assert.deepEqual(rows.map((row) => new Date(row.played_at).toISOString()),
        ["2026-10-11T18:12:49.000Z", "2026-10-01T12:34:56.000Z", "2026-01-11T19:12:49.000Z"]);
      for (const row of [rows[0], rows[2]]) {
        assert.ok(Math.abs(Date.now() - new Date(row.created_at).getTime()) < 60_000);
        assert.notDeepEqual(row.played_at, row.created_at);
      }
      assert.equal(await revision(), beforeRevision + 1);
      const player = (await db.query<{ user_id: string; avatar_url: string; matches: number }>("select * from public.players")).rows[0];
      assert.equal(player.matches, 3);
      assert.equal(player.user_id, "00000000-0000-0000-0000-000000000001");
      assert.equal(player.avatar_url, "discord-avatar");
    });

    await t.test("raw uploads and older importers fall back to the upload timestamp", async () => {
      await importMatches([{ player_name: "Alice", score: 1, played_at: null }, { player_name: "Alice", score: 2 }]);
      const matches = (await db.query<{ played_at: Date; created_at: Date }>(
        "select played_at, created_at from public.player_matches where score < 3")).rows;
      assert.equal(matches.length, 2);
      for (const match of matches) assert.deepEqual(match.played_at, match.created_at);
    });

    await t.test("invalid dates roll back stats, matches, history, audit and revision", async () => {
      const before = await snapshot();
      await assert.rejects(importMatches([
        { player_name: "Alice", played_at: "2026-10-11T20:12:49" },
        { player_name: "Alice", played_at: "2026-02-31T20:12:49" },
      ]), (error: any) => error.code === "22008");
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("stale revisions and browser roles still cannot write matches", async () => {
      const before = await snapshot();
      await assert.rejects(importMatches([], (await revision()) - 1), (error: any) => error.code === "40001");
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(db.query("select public.apply_match_import(0, '[]', '[]', '[]', '[]', 'TEST', 'Denied')"),
            (error: any) => error.code === "42501");
        } finally { await db.exec("reset role"); }
      }
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("reapplying the migration preserves all match dates", async () => {
      const before = await snapshot();
      await db.exec(migration);
      const after = await snapshot();
      assert.deepEqual(after.player_matches, before.player_matches);
      assert.deepEqual(after.players, before.players);
      assert.deepEqual(after.player_history, before.player_history);
      assert.deepEqual(after.audit_logs, before.audit_logs);
    });
  } finally { await db.close(); }
});
