import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Papa from "papaparse";
import { assignMatchId, readMatchSources } from "../supabase/functions/_shared/match-upload.ts";
import { normalizeMatchLog, parseMatchRows } from "../supabase/functions/upload-csv/parser.ts";

const adminId = "00000000-0000-0000-0000-000000000001";

test("global round count counts files rather than player participations", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table public.players (
        name text primary key, user_id uuid, is_admin boolean default false,
        bnet_accounts jsonb default '[]', matches integer, score integer, deaths integer,
        kdr text, accuracy text, kpm text, crouches integer, time_in_lobby numeric,
        elo text, rank integer, tag text
      );
      create table public.player_matches (
        id bigint generated always as identity primary key, player_name text,
        score integer check (score >= 0), deaths integer, accuracy numeric, kpm numeric,
        kdr numeric, crouches integer, time_in_lobby numeric, total_match_time integer,
        performance_score integer, created_at timestamptz not null default now()
      );
      create table public.player_history (
        id bigint generated always as identity primary key, player_name text, elo integer, rank integer
      );
      create table public.audit_logs (
        id bigint generated always as identity primary key, action text, admin_user text, details text
      );
      insert into public.players (name, user_id, is_admin, matches) values
        ('Admin', '${adminId}', true, 0), ('Alice', null, false, 2), ('Bob', null, false, 2);
      insert into public.player_matches (player_name, score, created_at) values
        ('Alice', 50, '2026-10-05T12:00:00Z'), ('Bob', 20, '2026-10-05T12:00:00Z'),
        ('Alice', 50, '2026-10-05T12:00:00Z'), ('Bob', 30, '2026-10-05T12:00:00Z');
      alter table public.player_matches enable row level security;
    `);
    const loadMigration = async (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
    await db.exec(await loadMigration("20261005210000_admin_leaderboard_reset.sql"));
    await db.exec(await loadMigration("20261012110000_preserve_player_history_on_rename.sql"));
    await db.exec(await loadMigration("20261012120000_add_match_date.sql"));
    // Two old rounds uploaded together, with known individual match timestamps.
    await db.exec(`update public.player_matches set played_at =
      case when id < 3 then '2026-10-01T18:00:00Z'::timestamptz else '2026-10-02T18:00:00Z'::timestamptz end
      where true;`);
    const migration = await loadMigration("20261012130000_count_imported_rounds.sql");
    await db.exec(migration);
    const count = async () => Number((await db.query<{ count: number }>("select public.get_match_count() as count")).rows[0].count);
    const revision = async () => Number((await db.query<{ revision: number }>("select revision from public.leaderboard_state")).rows[0].revision);
    const asRole = async <T>(role: string, action: () => Promise<T>) => {
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec("reset role"); }
    };
    const importMatches = async (matches: unknown[], expectedRevision?: number) => {
      const expected = expectedRevision ?? await revision();
      return asRole("service_role", () => db.query(
        "select public.apply_match_import($1, '[]', '[]', '[]', $2, 'TEST', 'Round count test')",
        [expected, JSON.stringify(matches)]));
    };
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["players", "player_matches", "player_history", "leaderboard_state", "audit_logs"]) {
        result[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return result;
    };

    await t.test("backfill groups players by match time, preserving individual match totals", async () => {
      assert.equal(await count(), 2);
      const rows = (await db.query<{ match_id: string }>("select match_id from public.player_matches order by id")).rows;
      assert.equal(rows[0].match_id, rows[1].match_id);
      assert.equal(rows[2].match_id, rows[3].match_id);
      assert.notEqual(rows[0].match_id, rows[2].match_id);
      assert.deepEqual((await db.query<{ matches: number }>("select matches from public.players where name <> 'Admin' order by name")).rows,
        [{ matches: 2 }, { matches: 2 }]);
    });

    await t.test("two files with two players each count as two rounds even with equal timestamps", async () => {
      const form = new FormData();
      const records = "Alice,50,10,60,20,5,1,150,150\nBob,20,10,60,8,2,1,150,150";
      // A filename/timestamp collision still represents two separate uploaded files.
      for (let file = 0; file < 2; file++) {
        form.append("file", new File([records], "Log-2026-10-11-20-12-49.txt"));
      }
      const sources = await readMatchSources(new Request("https://example.test/upload", { method: "POST", body: form }));
      const matches = sources.flatMap((source) => assignMatchId(parseMatchRows(Papa.parse<string[]>(
        normalizeMatchLog(source.text), { delimiter: ",", skipEmptyLines: "greedy" }).data)
        .map((match) => ({ ...match, played_at: source.played_at }))));
      const before = await count();
      await importMatches(matches);
      assert.equal(await count(), before + 2);
      const imported = (await db.query<{ players: number }>(
        "select count(*)::integer as players from public.player_matches where id > 4 group by match_id")).rows;
      assert.deepEqual(imported, [{ players: 2 }, { players: 2 }]);
      assert.equal((await db.query("select * from public.player_matches where player_name = 'Alice'")).rows.length, 4);
    });

    await t.test("legacy importer payloads share a fallback round ID for the request", async () => {
      const before = await count();
      await importMatches([{ player_name: "Alice", score: 50 }, { player_name: "Bob", score: 20 }]);
      assert.equal(await count(), before + 1);
    });

    await t.test("public roles may read the aggregate without reading or writing player rows", async () => {
      const expected = await count();
      for (const role of ["anon", "authenticated"]) {
        await asRole(role, async () => {
          assert.equal(await count(), expected);
          await assert.rejects(db.query("select * from public.player_matches"), (error: any) => error.code === "42501");
          await assert.rejects(db.query("select public.apply_match_import(0, '[]', '[]', '[]', '[]', 'TEST', 'Denied')"),
            (error: any) => error.code === "42501");
        });
      }
    });

    await t.test("failed and stale imports leave the round count and all data unchanged", async () => {
      const before = await snapshot();
      const beforeCount = await count();
      await assert.rejects(importMatches(assignMatchId([
        { player_name: "Alice", score: 50 }, { player_name: "Bob", score: -1 },
      ])), (error: any) => error.code === "23514");
      await assert.rejects(importMatches([], (await revision()) - 1), (error: any) => error.code === "40001");
      assert.equal(await count(), beforeCount);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("profile renames and reinstalling the migration preserve round identities", async () => {
      const beforeCount = await count();
      const beforeIds = (await db.query("select id, match_id from public.player_matches order by id")).rows;
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [adminId]);
      await asRole("authenticated", () => db.query("select public.rename_player('Alice', 'New Name')"));
      await db.exec(migration);
      assert.equal(await count(), beforeCount);
      assert.deepEqual((await db.query("select id, match_id from public.player_matches order by id")).rows, beforeIds);
      assert.equal((await db.query("select * from public.player_matches where player_name = 'New Name'")).rows.length, 5);
    });

    await t.test("admin reset returns the global round count to zero", async () => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [adminId]);
      await asRole("authenticated", () => db.query("select public.reset_leaderboard('RESET')"));
      assert.equal(await count(), 0);
      assert.equal((await db.query("select * from public.players")).rows.length, 3);
      assert.equal((await db.query("select * from public.player_matches")).rows.length, 0);
    });
  } finally { await db.close(); }
});
