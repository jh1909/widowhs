import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { rankPlayers } from "../supabase/functions/_shared/leaderboard.ts";

const adminId = "00000000-0000-0000-0000-000000000001";
const memberId = "00000000-0000-0000-0000-000000000002";

test("transactional leaderboard reset and imports", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table public.players (
        name text primary key, user_id uuid, is_admin boolean default false,
        is_banned boolean default false, avatar_url text, bnet_accounts jsonb,
        matches integer, score integer, deaths integer, kdr text, accuracy text,
        kpm text, crouches integer, time_in_lobby numeric, elo text, rank integer, tag text
      );
      create table public.player_matches (
        id bigint generated always as identity primary key, player_name text,
        score integer check (score >= 0), deaths integer, accuracy numeric, kpm numeric,
        kdr numeric, crouches integer, time_in_lobby numeric, total_match_time integer,
        performance_score integer
      );
      create table public.player_history (
        id bigint generated always as identity primary key, player_name text, elo integer, rank integer
      );
      create table public.audit_logs (
        id bigint generated always as identity primary key, action text, admin_user text, details text
      );
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261005210000_admin_leaderboard_reset.sql", import.meta.url), "utf8"));

    const seed = async () => {
      await db.exec(`
        reset role;
        drop trigger if exists fail_audit on public.audit_logs;
        truncate public.players, public.player_matches, public.player_history, public.audit_logs;
        update public.leaderboard_state set revision = 0;
        insert into public.players values
          ('Admin', '${adminId}', true, false, 'https://cdn.discordapp.com/admin.png', '["BattleAdmin"]',
            5, 100, 20, '5.00', '65%', '12.00', 1200, 1500, '1,300', 1, 'PRO'),
          ('notprx', '${memberId}', false, true, 'https://cdn.discordapp.com/member.png', '["BattleMember"]',
            2, 50, 10, '5.00', '45%', '8.00', 100, 600, '1,000', 2, '');
        insert into public.player_matches (player_name, score, total_match_time) values ('Admin', 100, 300), ('notprx', 50, 300);
        insert into public.player_history (player_name, elo, rank) values ('Admin', 1300, 1), ('notprx', 1000, 2);
        insert into public.audit_logs (action, admin_user, details) values ('OLD_EVENT', 'Admin', 'Kept for audit');
      `);
    };
    const asRole = async <T>(role: "anon" | "authenticated" | "service_role", userId: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec("reset role"); }
    };
    const reset = (confirmation = "RESET", userId = adminId) => asRole("authenticated", userId, () =>
      db.query<{ result: { players: number; matches: number; history: number } }>("select public.reset_leaderboard($1) as result", [confirmation]));
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["players", "player_matches", "player_history", "audit_logs", "leaderboard_state"]) {
        result[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return result;
    };
    const importedPlayer = { name: "Admin", matches: 1, score: 10, deaths: 2, kdr: "5.00", accuracy: "50.00%", kpm: "2.00", crouches: 0, time_in_lobby: 300, elo: "1,200", rank: 1, tag: "PRO" };
    const importData = (revision: number, score = 10) => asRole("service_role", "", () => db.query(
      "select public.apply_match_import($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)",
      [revision, JSON.stringify([importedPlayer]), JSON.stringify([{ name: "notprx", rank: 2 }]),
        JSON.stringify([{ player_name: "Admin", elo: 1200, rank: 1 }]),
        JSON.stringify([{ player_name: "Admin", score, deaths: 2, accuracy: 50, kpm: 2, kdr: 5, crouches: 0, time_in_lobby: 300, total_match_time: 300, performance_score: 1200 }]),
        "ADMIN_DASHBOARD", "Test import"]));

    await t.test("admin clears all statistics and histories, preserves identity and records the reset", async () => {
      await seed();
      const before = (await db.query("select name, user_id, is_admin, is_banned, avatar_url, bnet_accounts from public.players order by name")).rows;
      assert.deepEqual((await reset()).rows[0].result, { players: 2, matches: 2, history: 2 });
      assert.deepEqual((await db.query("select name, user_id, is_admin, is_banned, avatar_url, bnet_accounts from public.players order by name")).rows, before);
      const players = (await db.query<{ name: string; elo: string; rank: number; matches: number; score: number; deaths: number; kdr: string; accuracy: string; kpm: string; crouches: number; time_in_lobby: string; tag: string }>("select * from public.players")).rows;
      assert.deepEqual(rankPlayers(players), []);
      for (const player of players) {
        assert.equal(player.rank, 999999); assert.equal(player.tag, "");
        for (const field of ["matches", "score", "deaths", "crouches"] as const) assert.equal(player[field], 0);
        assert.equal(Number(player.time_in_lobby), 0);
        for (const field of ["elo", "kdr", "accuracy", "kpm"] as const) assert.equal(player[field], "-");
      }
      assert.equal((await db.query("select * from public.player_matches")).rows.length, 0);
      assert.equal((await db.query("select * from public.player_history")).rows.length, 0);
      const audit = (await db.query<{ action: string; admin_user: string; details: string }>("select * from public.audit_logs order by id")).rows;
      assert.equal(audit[0].action, "OLD_EVENT"); assert.equal(audit[1].action, "RESET_LEADERBOARD");
      assert.equal(audit[1].admin_user, "Admin"); assert.ok(audit[1].details.includes(adminId));
    });
    await t.test("reset can be repeated for the full release without removing profiles", async () => {
      await seed(); await reset();
      assert.deepEqual((await reset()).rows[0].result, { players: 2, matches: 0, history: 0 });
      assert.equal((await db.query("select * from public.players")).rows.length, 2);
    });
    await t.test("anonymous, logged-out and non-admin callers including notprx cannot reset", async () => {
      await seed(); const before = await snapshot();
      await assert.rejects(asRole("anon", "", () => db.query("select public.reset_leaderboard('RESET')")), { code: "42501" });
      await assert.rejects(reset("RESET", ""), { code: "42501" });
      await assert.rejects(reset("RESET", memberId), { code: "42501" });
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("incorrect confirmation changes nothing", async () => {
      await seed(); const before = await snapshot();
      for (const value of ["", "reset", "RESET "]) await assert.rejects(reset(value), { code: "22023" });
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("audit failure rolls back the entire reset", async () => {
      await seed(); const before = await snapshot();
      await db.exec(`create or replace function public.fail_audit_test() returns trigger language plpgsql as
        $$ begin raise exception 'Audit unavailable'; end $$;
        create trigger fail_audit before insert on public.audit_logs for each row execute function public.fail_audit_test();`);
      await assert.rejects(reset(), /Audit unavailable/);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("browsers cannot write revision state or invoke the service-only importer", async () => {
      await seed(); const before = await snapshot();
      await assert.rejects(asRole("authenticated", adminId, () => db.exec("update public.leaderboard_state set revision = 100")), { code: "42501" });
      await assert.rejects(asRole("authenticated", adminId, () => db.query("select public.apply_match_import(0, '[]', '[]', '[]', '[]', 'Admin', 'Forged')")), { code: "42501" });
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("a stale import cannot restore data after reset; a fresh import works", async () => {
      await seed(); await reset(); const empty = await snapshot();
      await assert.rejects(importData(0), { code: "40001" });
      assert.deepEqual(await snapshot(), empty);
      await importData(1);
      assert.deepEqual((await db.query("select matches, score, elo from public.players where name = 'Admin'")).rows[0], { matches: 1, score: 10, elo: "1,200" });
      assert.equal((await db.query("select * from public.player_matches")).rows.length, 1);
      assert.equal((await db.query("select * from public.player_history")).rows.length, 1);
    });
    await t.test("two uploads with the same snapshot cannot overwrite each other", async () => {
      await seed(); await importData(0); const after = await snapshot();
      await assert.rejects(importData(0), { code: "40001" });
      assert.deepEqual(await snapshot(), after);
    });
    await t.test("invalid match rolls back imported stats, ranks, history and revision", async () => {
      await seed(); const before = await snapshot();
      await assert.rejects(importData(0, -1), { code: "23514" });
      assert.deepEqual(await snapshot(), before);
    });
  } finally { await db.close(); }
});
