import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildMatchImport, type ImportPlayer, type ImportedMatch } from "../supabase/functions/_shared/import-stats.ts";
import { assignMatchId } from "../supabase/functions/_shared/match-upload.ts";
import { createPlayerMap } from "../supabase/functions/_shared/player-map.ts";
import { calculateRating } from "../supabase/functions/_shared/rating.ts";

const alice = "00000000-0000-0000-0000-000000000001";
const bob = "00000000-0000-0000-0000-000000000002";
const outsider = "00000000-0000-0000-0000-000000000003";
const round = (names: string[], date = "2026-10-11T20:12:49"): ImportedMatch[] => assignMatchId(names.map((name, index) => ({
  player_name: name, score: index === 0 ? 50 : 20, deaths: 10, accuracy: 60, kpm: 20,
  kdr: index === 0 ? 5 : 2, crouches: 120, time_in_lobby: 149, total_match_time: 160, played_at: date,
})));

for (const accountColumn of ["jsonb", "text[]"]) {
test(`global history preserves all players and safely links imported profiles (${accountColumn})`, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      grant usage on schema auth to anon, authenticated, service_role;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.identities (user_id uuid, provider text);
      insert into auth.identities values ('${alice}', 'discord'), ('${bob}', 'discord'), ('${outsider}', 'email');
      create table public.players (name text primary key, user_id uuid, is_admin boolean default false,
        bnet_accounts ${accountColumn} default '${accountColumn === "jsonb" ? "[]" : "{}"}', matches integer, score integer, deaths integer,
        kdr text, accuracy text, kpm text, crouches integer, time_in_lobby numeric, elo text, rank integer, tag text);
      create table public.player_matches (id bigint generated always as identity primary key, player_name text,
        score integer check (score >= 0), deaths integer, accuracy numeric, kpm numeric, kdr numeric,
        crouches integer, time_in_lobby numeric, total_match_time integer, performance_score integer,
        created_at timestamptz not null default now());
      create table public.player_history (id bigint generated always as identity primary key,
        player_name text, elo integer, rank integer, created_at timestamptz default now());
      create table public.audit_logs (id bigint generated always as identity primary key, action text, admin_user text, details text);
      insert into public.players (name, user_id, is_admin, matches, elo) values ('Admin', '${bob}', true, 0, '-');
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
      create policy test_admin_access on public.players to authenticated using (auth.uid() = '${bob}') with check (auth.uid() = '${bob}');
      grant select, insert, update on public.players to authenticated;
      alter table public.player_matches enable row level security;
    `);
    const migration = async (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
    for (const name of ["20261005210000_admin_leaderboard_reset.sql", "20261012110000_preserve_player_history_on_rename.sql",
      "20261012120000_add_match_date.sql", "20261012130000_count_imported_rounds.sql", "20261012140000_global_match_history.sql"]) {
      await db.exec(await migration(name));
    }
    const asRole = async <T>(role: string, action: () => Promise<T>) => {
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec("reset role"); }
    };
    const actor = async (id: string) => { await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]); };
    const revision = async () => Number((await db.query<{ revision: number }>("select revision from public.leaderboard_state")).rows[0].revision);
    const importRound = async (matches: ImportedMatch[], expected?: number) => {
      const players = (await db.query<ImportPlayer>("select * from public.players")).rows;
      const payload = buildMatchImport(players, matches);
      const rev = expected ?? await revision();
      await asRole("service_role", () => db.query("select public.apply_match_import($1, $2, $3, $4, $5, 'TEST', 'All players')",
        [rev, ...[payload.players, payload.ranks, payload.history, payload.matches].map(value => JSON.stringify(value))]));
      return payload;
    };
    const publicList = async (limit = 25, offset = 0) => (await asRole("anon", () =>
      db.query<{ data: { total: number; matches: any[] } }>("select public.get_global_matches($1, $2) as data", [limit, offset]))).rows[0].data;
    const publicDetails = async (id: string) => (await asRole("anon", () =>
      db.query<{ data: any[] }>("select public.get_match_details($1) as data", [id]))).rows[0].data;
    const profile = async (name: string) => (await db.query<any>("select * from public.players where name = $1", [name])).rows[0];
    const first = round(["BattleAlice", "Лев", "__proto__"]);
    const second = round(["BattleAlice", "Unregistered", "Лев"], "2026-10-12T20:00:00");

    await t.test("imports unregistered players, complete rounds and original names", async () => {
      const result = await importRound([...first, ...second]);
      assert.equal(result.roundCount, 2);
      assert.equal(result.matches.length, 6);
      assert.equal((await profile("BattleAlice")).matches, 2);
      assert.equal((await profile("Лев")).matches, 2);
      assert.equal((await profile("__proto__")).is_verified, false);
      assert.equal((await profile("BattleAlice")).user_id, null);
      const list = await publicList();
      assert.equal(list.total, 2);
      assert.deepEqual(list.matches.map(match => match.player_count), [3, 3]);
      assert.equal(list.matches[0].match_id, second[0].match_id);
      assert.equal(list.matches[0].winner, "BattleAlice");
      const details = await publicDetails(first[0].match_id);
      assert.equal(details.length, 3);
      assert.equal(details[0].logged_player_name, "BattleAlice");
      assert.equal(details[0].time_in_lobby, 149);
      assert.equal(details[0].total_match_time, 160);
      assert.equal(details[0].performance_score, calculateRating(first[0]));
      assert.equal(new Date(list.matches[1].played_at).toISOString(), "2026-10-11T18:12:49.000Z");
    });

    await t.test("pagination and unknown matches expose only public stats", async () => {
      assert.equal((await publicList(1, 1)).matches[0].match_id, first[0].match_id);
      assert.equal((await publicList(1, 2)).matches.length, 0);
      assert.equal((await publicList(1, 2)).total, 2);
      assert.deepEqual(await publicDetails(outsider), []);
      const rows = await publicDetails(first[0].match_id);
      for (const row of rows) for (const key of ["user_id", "bnet_accounts", "is_admin", "email", "previous_names"]) assert.equal(key in row, false);
      await asRole("anon", async () => {
        await assert.rejects(db.query("select * from public.player_matches"), (error: any) => error.code === "42501");
        await assert.rejects(db.query("select public.apply_match_import(0, '[]', '[]', '[]', '[]', '', '')"), (error: any) => error.code === "42501");
      });
    });

    let mainName = "";
    await t.test("Discord login does not implicitly take a matching imported name", async () => {
      await actor(alice);
      const result = await asRole("authenticated", () => db.query<{ data: any }>(
        "select public.ensure_discord_player('BattleAlice', null) as data"));
      mainName = result.rows[0].data.name;
      assert.notEqual(mainName, "BattleAlice");
      assert.equal(result.rows[0].data.is_verified, false);
      assert.equal((await profile("BattleAlice")).user_id, null);
      assert.equal((await profile(mainName)).user_id, alice);
      const again = await asRole("authenticated", () => db.query<{ data: any }>("select public.ensure_discord_player('Changed Discord name', null) as data"));
      assert.equal(again.rows[0].data.name, mainName);
    });

    await t.test("linking merges past stats, history and ranks without changing round IDs", async () => {
      const before = await profile("BattleAlice");
      const result = await asRole("authenticated", () => db.query<{ data: any }>(
        "select public.link_bnet_account($1, 'BattleAlice#12345', false) as data", [mainName]));
      assert.equal(result.rows[0].data.is_verified, true);
      assert.equal(await profile("BattleAlice"), undefined);
      const main = await profile(mainName);
      for (const field of ["score", "deaths", "matches", "crouches", "time_in_lobby", "elo", "kdr"]) assert.equal(main[field], before[field]);
      assert.deepEqual(main.bnet_accounts, ["BattleAlice"]);
      assert.equal((await publicList()).total, 2);
      const details = await publicDetails(first[0].match_id);
      assert.equal(details[0].player_name, mainName);
      assert.equal(details[0].logged_player_name, "BattleAlice");
      assert.equal(details[0].is_verified, true);
      assert.ok((await db.query("select * from public.player_history where player_name = $1", [mainName])).rows.length >= 2);
      const map = createPlayerMap((await db.query<any>("select * from public.players")).rows);
      assert.equal(map.get("battlealice")?.name, mainName);
    });

    await t.test("future imports retain account ownership and verified status", async () => {
      const next = round(["BattleAlice", "NewPlayer"]);
      await importRound(next);
      assert.equal((await profile(mainName)).matches, 3);
      assert.equal((await profile(mainName)).user_id, alice);
      assert.equal((await profile(mainName)).is_verified, true);
      assert.equal(await profile("BattleAlice"), undefined);
      assert.equal((await publicDetails(next[0].match_id)).length, 2);
    });

    await t.test("direct verification, ownership and admin changes cannot bypass the RPCs", async () => {
      await asRole("authenticated", async () => {
        await db.query("update public.players set is_verified = false where name = $1", [mainName]);
        assert.equal((await profile(mainName)).is_verified, true);
        for (const query of ["is_admin = true", `user_id = '${bob}'`,
          `bnet_accounts = '${accountColumn === "jsonb" ? '["Admin"]' : '{Admin}'}'`, `previous_names = array['Admin']`]) {
          await assert.rejects(db.query(`update public.players set ${query} where name = $1`, [mainName]), (error: any) => error.code === "42501");
        }
        await assert.rejects(db.query("select public.link_bnet_account('Admin', 'NewPlayer', false)"), (error: any) => error.code === "42501");
        await assert.rejects(db.query("select public.link_bnet_account($1, 'Admin', false)", [mainName]), (error: any) => error.code === "23505");
      });
      await actor(outsider);
      await asRole("authenticated", async () => {
        await assert.rejects(db.query("select public.ensure_discord_player('Email user', null)"), (error: any) => error.code === "42501");
        await assert.rejects(db.query("select public.link_bnet_account($1, 'NewPlayer', false)", [mainName]), (error: any) => error.code === "42501");
      });
      await actor(alice);
    });

    await t.test("existing admin role management still works", async () => {
      await actor(bob);
      await asRole("authenticated", () => db.query("update public.players set is_admin = true where name = 'NewPlayer'"));
      assert.equal((await profile("NewPlayer")).is_admin, true);
      await asRole("authenticated", () => db.query("update public.players set is_admin = false where name = 'NewPlayer'"));
      await actor(alice);
    });

    await t.test("renaming retains global results and stale imports are atomic", async () => {
      const oldRevision = await revision();
      await asRole("authenticated", () => db.query("select public.rename_player($1, 'Alice Renamed')", [mainName]));
      mainName = "Alice Renamed";
      const details = await publicDetails(first[0].match_id);
      assert.equal(details[0].player_name, mainName);
      assert.equal(details[0].logged_player_name, "BattleAlice");
      await assert.rejects(importRound(round(["RollbackPlayer"]), oldRevision), (error: any) => error.code === "40001");
      await assert.rejects(importRound(round(["RollbackPlayer"]).map(match => ({ ...match, score: -1 }))), (error: any) => error.code === "23514");
      assert.equal(await profile("RollbackPlayer"), undefined);
      assert.equal((await publicList()).total, 3);
    });

    await t.test("a second account combines weighted averages and enforces the account limit", async () => {
      const main = await profile(mainName);
      const donor = await profile("Лев");
      await asRole("authenticated", () => db.query("select public.link_bnet_account($1, 'Лев#456', false)", [mainName]));
      const merged = await profile(mainName);
      assert.equal(merged.matches, main.matches + donor.matches);
      assert.equal(merged.score, main.score + donor.score);
      const kdr = (Number(main.kdr) * main.matches + Number(donor.kdr) * donor.matches) / merged.matches;
      assert.equal(Number(merged.kdr), Number(kdr.toFixed(2)));
      assert.equal(Number(merged.elo.replace(/,/g, "")), calculateRating({ kpm: 20, accuracy: 60, kdr }));
      assert.equal((await publicDetails(first[0].match_id)).find(player => player.logged_player_name === "Лев")?.player_name, mainName);
      assert.equal((await publicList()).total, 3);
      await asRole("authenticated", () => assert.rejects(
        db.query("select public.link_bnet_account($1, 'ThirdAccount', false)", [mainName]), (error: any) => error.code === "22023"));
    });

    await t.test("removing the last account removes verification while preserving history", async () => {
      await asRole("authenticated", () => db.query("select public.link_bnet_account($1, 'BattleAlice', true)", [mainName]));
      assert.equal((await profile(mainName)).is_verified, true);
      await asRole("authenticated", () => db.query("select public.link_bnet_account($1, 'Лев', true)", [mainName]));
      assert.equal((await profile(mainName)).is_verified, false);
      assert.equal((await profile(mainName)).matches, 5);
      assert.equal((await publicDetails(first[0].match_id))[0].is_verified, false);
      await asRole("authenticated", () => db.query("update public.players set is_verified = true where name = $1", [mainName]));
      assert.equal((await profile(mainName)).is_verified, false);
    });

    await t.test("reinstalling preserves round IDs, links and existing public history", async () => {
      const before = await publicList();
      await db.exec(await migration("20261012140000_global_match_history.sql"));
      assert.deepEqual(await publicList(), before);
      assert.equal((await profile(mainName)).matches, 5);
    });

    await t.test("reset clears the global history and retains identities", async () => {
      await actor(bob);
      await asRole("authenticated", () => db.query("select public.reset_leaderboard('RESET')"));
      assert.equal((await publicList()).total, 0);
      assert.deepEqual(await publicDetails(first[0].match_id), []);
      assert.equal((await profile(mainName)).user_id, alice);
    });
  } finally { await db.close(); }
});
}
