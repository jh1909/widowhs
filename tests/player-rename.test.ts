import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createPlayerMap } from "../supabase/functions/_shared/player-map.ts";

const adminId = "00000000-0000-0000-0000-000000000001";
const aliceId = "00000000-0000-0000-0000-000000000002";
const bobId = "00000000-0000-0000-0000-000000000003";

test("player renames preserve histories, identity and import mapping transactionally", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table public.players (
        name text primary key, user_id uuid, is_admin boolean default false,
        avatar_url text, bnet_accounts jsonb, matches integer, score integer,
        deaths integer, kdr text, accuracy text, kpm text, crouches integer,
        time_in_lobby numeric, elo text, rank integer, tag text
      );
      create table public.player_matches (
        id bigint generated always as identity primary key, player_name text,
        score integer, deaths integer, accuracy numeric, kpm numeric, kdr numeric,
        crouches integer, time_in_lobby numeric, total_match_time integer, performance_score integer
      );
      create table public.player_history (
        id bigint generated always as identity primary key, player_name text, elo integer, rank integer
      );
      create table public.audit_logs (
        id bigint generated always as identity primary key, action text, admin_user text, details text
      );
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated
        using (user_id = auth.uid()) with check (user_id = auth.uid());
      grant select, update on public.players to authenticated;
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261005210000_admin_leaderboard_reset.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261012100000_fix_admin_reset_where.sql", import.meta.url), "utf8"));
    const renameMigration = await readFile(new URL("../supabase/migrations/20261012110000_preserve_player_history_on_rename.sql", import.meta.url), "utf8");
    await db.exec(renameMigration);
    const seed = async () => {
      await db.exec(`
        drop trigger if exists fail_audit on public.audit_logs;
        truncate public.players, public.player_matches, public.player_history, public.audit_logs;
        update public.leaderboard_state set revision = 0 where singleton;
        insert into public.players
          (name, user_id, is_admin, avatar_url, bnet_accounts, matches, score, deaths,
            kdr, accuracy, kpm, crouches, time_in_lobby, elo, rank, tag) values
          ('Admin', '${adminId}', true, 'avatar-admin', '[]', 1, 50, 20, '2.50', '50%', '10', 5, 300, '900', 1, ''),
          ('Alice', '${aliceId}', false, 'avatar-alice', '["BattleAlice"]', 2, 100, 30, '2.85', '50%', '10', 10, 310, '800', 2, ''),
          ('Bob', '${bobId}', false, 'avatar-bob', '["BattleBob"]', 1, 20, 30, '0.67', '30%', '5', 5, 300, '500', 3, '');
        insert into public.player_matches (player_name, score, deaths, time_in_lobby, total_match_time, performance_score)
          values ('Alice', 50, 10, 130, 170, 900), ('Alice', 50, 20, 180, 300, 700), ('Bob', 20, 30, 300, 300, 500);
        insert into public.player_history (player_name, elo, rank)
          values ('Alice', 750, 2), ('Alice', 800, 2), ('Bob', 500, 3);
      `);
    };
    const asRole = async <T>(role: string, actor: string, action: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor]);
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec("reset role"); }
    };
    const rename = (oldName: string, newName: string, actor = aliceId) => asRole("authenticated", actor, () =>
      db.query<{ result: { name: string; user_id: string } }>("select public.rename_player($1, $2) as result", [oldName, newName]));
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ["players", "player_matches", "player_history", "leaderboard_state", "audit_logs"]) {
        rows[table] = (await db.query(`select * from public.${table} order by 1`)).rows;
      }
      return rows;
    };

    await t.test("own rename preserves every match, PB, ELO history and stable auth identity", async () => {
      await seed();
      const before = (await db.query<Record<string, unknown>>("select * from public.players where name = 'Alice'")).rows[0];
      const beforeMatches = (await db.query("select * from public.player_matches order by id")).rows;
      assert.deepEqual((await rename("Alice", "New Name")).rows[0].result, { name: "New Name", user_id: aliceId });
      const after = (await db.query<Record<string, unknown>>("select * from public.players where user_id = $1", [aliceId])).rows[0];
      assert.deepEqual(after, { ...before, name: "New Name", previous_names: ["Alice"] });
      assert.deepEqual((await db.query("select * from public.player_matches order by id")).rows,
        beforeMatches.map((match: any) => match.player_name === "Alice" ? { ...match, player_name: "New Name" } : match));
      assert.equal((await db.query("select * from public.player_history where player_name = 'New Name'")).rows.length, 2);
      assert.equal((await db.query<{ pb: number }>("select min(time_in_lobby)::integer as pb from public.player_matches where player_name = 'New Name' and score >= 50")).rows[0].pb, 130);
      assert.equal(Number((await db.query<{ revision: number }>("select revision from public.leaderboard_state")).rows[0].revision), 1);
      const players = (await db.query<{ name: string; bnet_accounts: string[]; previous_names: string[] }>("select name, bnet_accounts, previous_names from public.players")).rows;
      assert.equal(createPlayerMap(players).get("alice")?.name, "New Name");
      assert.equal(createPlayerMap(players).get("battlealice")?.name, "New Name");
    });

    await t.test("repeated and case-only renames keep all earlier import aliases", async () => {
      await seed();
      await rename("Alice", "ALICE");
      await rename("ALICE", "A_100%");
      const player = (await db.query<{ previous_names: string[] }>("select * from public.players where user_id = $1", [aliceId])).rows[0];
      assert.deepEqual(player.previous_names, ["Alice", "ALICE"]);
      assert.equal((await db.query("select * from public.player_matches where player_name = 'A_100%'")).rows.length, 2);
    });

    await t.test("anonymous and foreign-profile renames are rejected without writes", async () => {
      await seed();
      const before = await snapshot();
      await assert.rejects(asRole("anon", "", () => db.query("select public.rename_player('Alice', 'Stolen')")),
        (error: any) => error.code === "42501");
      await assert.rejects(rename("Bob", "Stolen"), (error: any) => error.code === "42501");
      await assert.rejects(rename("Alice", "LoggedOut", ""), (error: any) => error.code === "42501");
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("admin may rename another profile without renaming the admin", async () => {
      await seed();
      await rename("Bob", "Robert", adminId);
      assert.equal((await db.query<{ name: string }>("select name from public.players where user_id = $1", [adminId])).rows[0].name, "Admin");
      assert.equal((await db.query<{ player_name: string }>("select player_name from public.player_matches where score = 20")).rows[0].player_name, "Robert");
    });

    await t.test("duplicate names, linked accounts and reserved old aliases cannot be claimed", async () => {
      await seed();
      const before = await snapshot();
      for (const name of ["bob", "BattleBob", "", "me"]) {
        await assert.rejects(rename("Alice", name));
      }
      assert.deepEqual(await snapshot(), before);
      await rename("Alice", "New Name");
      await assert.rejects(rename("Bob", "alice", bobId), (error: any) => error.code === "23505");
      await assert.rejects(db.query("insert into public.players (name) values ('ALICE')"), (error: any) => error.code === "23505");
    });

    await t.test("legacy direct name updates also preserve histories", async () => {
      await seed();
      await asRole("authenticated", aliceId, () => db.query("update public.players set name = 'Legacy Rename' where name = 'Alice'"));
      assert.equal((await db.query("select * from public.player_matches where player_name = 'Legacy Rename'")).rows.length, 2);
      assert.equal((await db.query("select * from public.player_history where player_name = 'Legacy Rename'")).rows.length, 2);
    });

    await t.test("audit failure rolls back name, aliases, histories and revision", async () => {
      await seed();
      const before = await snapshot();
      await db.exec(`create function public.fail_rename_audit() returns trigger language plpgsql as
        $$ begin raise exception 'Audit unavailable'; end $$;
        create trigger fail_audit before insert on public.audit_logs for each row execute function public.fail_rename_audit();`);
      await assert.rejects(rename("Alice", "Failed"), /Audit unavailable/);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("rename rejects an import computed under the old name", async () => {
      await seed();
      await rename("Alice", "New Name");
      await assert.rejects(asRole("service_role", "", () => db.query(
        "select public.apply_match_import(0, '[]', '[]', '[]', '[]', 'TEST', 'Stale import')")),
        (error: any) => error.code === "40001");
    });

    await t.test("reinstalling the migration preserves matches and profile data", async () => {
      await seed();
      await rename("Alice", "New Name");
      const before = await snapshot();
      await db.exec(renameMigration);
      const after = await snapshot();
      assert.deepEqual(after.players, before.players);
      assert.deepEqual(after.player_matches, before.player_matches);
      assert.deepEqual(after.player_history, before.player_history);
    });
  } finally {
    await db.close();
  }
});
