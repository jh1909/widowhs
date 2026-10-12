import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildMatchImport } from "../supabase/functions/_shared/import-stats.ts";
import { assignMatchId } from "../supabase/functions/_shared/match-upload.ts";

const alice = "00000000-0000-0000-0000-000000000001";
const bob = "00000000-0000-0000-0000-000000000002";
const outsider = "00000000-0000-0000-0000-000000000003";
const oauthMigration = new URL("../supabase/migrations/20261012220000_battlenet_oauth.sql", import.meta.url);

for (const accountColumn of ["text[]", "jsonb"]) {
test(`Battle.net OAuth claims and verification (${accountColumn})`, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${alice}'), ('${bob}'), ('${outsider}');
      create table auth.identities(user_id uuid, provider text);
      insert into auth.identities values ('${alice}', 'discord'), ('${bob}', 'discord'), ('${outsider}', 'email');
      create table public.players(name text primary key, user_id uuid, is_admin boolean default false,
        bnet_accounts ${accountColumn} default '${accountColumn === "jsonb" ? "[]" : "{}"}', matches integer, score integer, deaths integer,
        kdr text, accuracy text, kpm text, crouches integer, time_in_lobby numeric, elo text, rank integer, tag text);
      create table public.player_matches(id bigint generated always as identity primary key, player_name text,
        score integer, deaths integer, accuracy numeric, kpm numeric, kdr numeric, crouches integer,
        time_in_lobby numeric, total_match_time integer, performance_score integer, created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,
        player_name text, elo integer, rank integer, created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key, action text, admin_user text, details text);
      insert into public.players(name, user_id, matches, elo) values ('Alice', '${alice}', 0, '-'), ('Bob', '${bob}', 0, '-');
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated using(user_id = auth.uid()) with check(user_id = auth.uid());
      grant select, insert, update on public.players to authenticated;
    `);
    for (const name of ["20261005210000_admin_leaderboard_reset.sql", "20261012110000_preserve_player_history_on_rename.sql",
      "20261012120000_add_match_date.sql", "20261012130000_count_imported_rounds.sql", "20261012140000_global_match_history.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
    }
    const role = async <T>(value: string, action: () => Promise<T>) => {
      await db.exec(`set role ${value}`);
      try { return await action(); } finally { await db.exec("reset role"); }
    };
    const actor = (value: string) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [value]);
    const profile = async (name = "Alice") => (await db.query<any>("select * from public.players where name = $1", [name])).rows[0];
    const connect = (userId: string, id: string, tag: string) => role("service_role", () => db.query(
      "select public.complete_battlenet_account_link($1, $2, $3)", [userId, id, tag]));
    const publicAccounts = async (name = "Alice") => (await role("anon", () => db.query<{ data: any[] }>(
      "select public.get_player_bnet_accounts($1) as data", [name]))).rows[0].data;
    const importMatch = async (name: string) => {
      const matches = assignMatchId([{ player_name: name, score: 50, deaths: 10, accuracy: 60,
        kpm: 20, kdr: 5, crouches: 100, time_in_lobby: 149, total_match_time: 160, played_at: "2026-10-12T20:00:00" }]);
      const payload = buildMatchImport((await db.query<any>("select * from public.players")).rows, matches);
      const revision = (await db.query<any>("select revision from public.leaderboard_state")).rows[0].revision;
      await role("service_role", () => db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','test')",
        [revision, ...[payload.players, payload.ranks, payload.history, payload.matches].map(value => JSON.stringify(value))]));
      return matches[0].match_id;
    };
    await importMatch("BattleAlice");
    await actor(alice);
    await role("authenticated", () => db.query("select public.link_bnet_account('Alice','Legacy#12345',false)"));
    assert.equal((await profile()).is_verified, true);
    await db.exec(await readFile(oauthMigration, "utf8"));

    await t.test("migration preserves legacy claims/stats but requires proof for verification", async () => {
      assert.deepEqual((await profile()).bnet_accounts, ["Legacy"]);
      assert.equal((await profile()).is_verified, false);
      assert.deepEqual(await publicAccounts(), [{ name: "Legacy", battletag: null, verified: false }]);
      await assert.rejects(role("authenticated", () => db.query("select public.link_bnet_account('Alice','Forged',false)")),
        (error: any) => error.code === "42501");
      await role("authenticated", () => db.query("update public.players set is_verified = true where name = 'Alice'"));
      assert.equal((await profile()).is_verified, false);
    });

    await t.test("private proofs, OAuth states and service-only link functions cannot be read or forged by browsers", async () => {
      for (const who of ["anon", "authenticated"]) {
        for (const sql of ["select * from public.battlenet_account_links", "select * from public.battlenet_oauth_requests",
          `select public.complete_battlenet_account_link('${alice}','1','Forged#12345')`,
          `select public._link_bnet_account_impl('${alice}','Alice','Forged',false)`,
          `select public.create_battlenet_oauth_request('${"a".repeat(64)}','${alice}','https://evil.test/','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`,
          `select public.consume_battlenet_oauth_request('${"a".repeat(64)}')`]) {
          await assert.rejects(role(who, () => db.query(sql)), (error: any) => error.code === "42501");
        }
      }
      await assert.rejects(role("authenticated", () => db.query(
        "select public.finish_battlenet_oauth($1,$2,$3)", ["a".repeat(64), alice, "b".repeat(64)])),
        (error: any) => error.code === "42501");
    });

    await t.test("provider login merges imported history, stores full tag privately and exposes safe labels", async () => {
      const donor = await profile("BattleAlice");
      await connect(alice, "100", "BattleAlice#12345");
      assert.equal(await profile("BattleAlice"), undefined);
      const main = await profile();
      assert.equal(main.is_verified, true);
      assert.equal(main.matches, donor.matches); assert.equal(main.elo, donor.elo);
      assert.deepEqual(main.bnet_accounts, ["Legacy", "BattleAlice"]);
      const labels = await publicAccounts();
      assert.deepEqual(labels[1], { name: "BattleAlice", battletag: "BattleAlice#12345", verified: true });
      assert.ok(!JSON.stringify(labels).includes("account_id"));
      assert.equal((await db.query<any>("select logged_player_name from public.player_matches where player_name='Alice'")).rows[0].logged_player_name, "BattleAlice");
      await importMatch("BattleAlice");
      assert.equal((await profile()).matches, 2);
      assert.equal((await profile()).is_verified, true);
    });

    await t.test("first claimant wins even for different Battle.net IDs with the same base name", async () => {
      await assert.rejects(connect(bob, "200", "battlealice#98765"), (error: any) => error.code === "23505");
      await assert.rejects(connect(bob, "100", "Different#98765"), (error: any) => error.code === "23505");
      await assert.rejects(connect(bob, "201", "Legacy#98765"), (error: any) => error.code === "23505");
      await assert.rejects(connect(bob, "202", "Alice#98765"), (error: any) => error.code === "23505");
      assert.equal((await profile("Bob")).is_verified, false);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links")).rows[0].n, 1);
    });

    await t.test("reverification is idempotent and legacy slots can be verified at the two-account limit", async () => {
      await connect(alice, "100", "BattleAlice#12345");
      await connect(alice, "101", "Legacy#12345");
      assert.equal((await publicAccounts()).filter(account => account.verified).length, 2);
      const before = await profile();
      await assert.rejects(connect(alice, "102", "Third#12345"), (error: any) => error.code === "22023");
      assert.deepEqual((await profile()).bnet_accounts, before.bnet_accounts);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links")).rows[0].n, 2);
    });

    await t.test("Blizzard name changes keep account ID, match history and previous import mapping", async () => {
      await connect(alice, "100", "NewBattleAlice#12345");
      assert.equal((await profile()).matches, 2);
      assert.equal((await publicAccounts()).find(account => account.name === "NewBattleAlice")?.verified, true);
      await importMatch("BattleAlice");
      await importMatch("NewBattleAlice");
      assert.equal((await profile()).matches, 4);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links where account_id='100'")).rows[0].n, 1);
      await assert.rejects(connect(bob, "203", "BattleAlice#98765"), (error: any) => error.code === "23505");
    });

    await t.test("unlinking removes proof and verification while preserving matches; ownership checks remain", async () => {
      await actor(bob);
      await assert.rejects(role("authenticated", () => db.query("select public.link_bnet_account('Alice','Legacy',true)")), (error: any) => error.code === "42501");
      await actor(alice);
      await role("authenticated", () => db.query("select public.link_bnet_account('Alice','Legacy',true)"));
      assert.equal((await profile()).is_verified, true);
      await role("authenticated", () => db.query("select public.link_bnet_account('Alice','NewBattleAlice',true)"));
      assert.equal((await profile()).is_verified, false);
      assert.equal((await profile()).matches, 4);
      assert.deepEqual(await publicAccounts(), []);
    });

    await t.test("pending states expire, are single-use, require Discord and limit concurrent attempts", async () => {
      const create = (hash: string, user = alice) => role("service_role", () => db.query(
        "select public.create_battlenet_oauth_request($1,$2,'https://site.test/','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')", [hash, user]));
      const consume = async (hash: string) => (await role("service_role", () => db.query<any>(
        "select public.consume_battlenet_oauth_request($1) as data", [hash]))).rows[0].data;
      await assert.rejects(create("a".repeat(64), outsider), (error: any) => error.code === "42501");
      await create("a".repeat(64));
      assert.deepEqual(await consume("a".repeat(64)), { user_id: alice, redirect_url: "https://site.test/", browser_hash: "b".repeat(64) });
      assert.equal(await consume("a".repeat(64)), null);
      await create("b".repeat(64));
      await db.exec("update public.battlenet_oauth_requests set expires_at=now()-interval '1 second'");
      assert.equal(await consume("b".repeat(64)), null);
      for (const char of ["a", "b", "c", "d", "e"]) await create(char.repeat(64));
      await assert.rejects(create("f".repeat(64)), (error: any) => error.code === "54000");
    });

    await t.test("callback proof cannot claim an account until the initiating browser and Discord session finish it", async () => {
      const stateHash = "f".repeat(64); const browserHash = "9".repeat(64);
      const before = (await profile()).matches;
      await role("service_role", () => db.query("select public.save_battlenet_oauth_result($1,$2,'https://site.test/',$3,'500','BrowserProof#12345')",
        [stateHash, alice, browserHash]));
      assert.equal((await profile()).is_verified, false);
      assert.equal((await role("service_role", () => db.query<any>("select public.consume_battlenet_oauth_request($1) as data", [stateHash]))).rows[0].data, null);
      const finish = (user = alice, hash = browserHash) => role("service_role", () => db.query(
        "select public.finish_battlenet_oauth($1,$2,$3)", [stateHash, user, hash]));
      await assert.rejects(finish(bob), (error: any) => error.code === "42501");
      await assert.rejects(finish(alice, "8".repeat(64)), (error: any) => error.code === "42501");
      assert.equal((await profile()).is_verified, false);
      await finish();
      assert.equal((await profile()).is_verified, true);
      assert.equal((await profile()).matches, before);
      assert.equal((await publicAccounts())[0].battletag, "BrowserProof#12345");
      await assert.rejects(finish(), (error: any) => error.code === "42501");
      await actor(alice);
      await role("authenticated", () => db.query("select public.link_bnet_account('Alice','BrowserProof',true)"));
      await role("service_role", () => db.query("select public.save_battlenet_oauth_result($1,$2,'https://site.test/',$3,'501','ExpiredProof#12345')",
        [stateHash, alice, browserHash]));
      await db.query("update public.battlenet_oauth_requests set expires_at=now()-interval '1 second' where state_hash=$1", [stateHash]);
      await assert.rejects(finish(), (error: any) => error.code === "42501");
      assert.equal((await profile()).is_verified, false);
    });

    await t.test("a failure after merging a donor rolls back match transfers, stats and the OAuth claim", async () => {
      const roundId = await importMatch("RollbackPlayer");
      const before = await profile(); const donor = await profile("RollbackPlayer");
      await db.exec(`create function public.fail_oauth_audit() returns trigger language plpgsql as $$
        begin if new.action='VERIFY_BNET_ACCOUNT' then raise exception 'test rollback'; end if; return new; end $$;
        create trigger fail_oauth_audit before insert on public.audit_logs for each row execute function public.fail_oauth_audit();`);
      await assert.rejects(connect(alice, "600", "RollbackPlayer#12345"));
      assert.deepEqual(await profile(), before); assert.deepEqual(await profile("RollbackPlayer"), donor);
      assert.equal((await db.query<any>("select player_name from public.player_matches where match_id=$1", [roundId])).rows[0].player_name, "RollbackPlayer");
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links where account_id='600'")).rows[0].n, 0);
      await db.exec("drop trigger fail_oauth_audit on public.audit_logs; drop function public.fail_oauth_audit()");
    });

    await t.test("invalid identities and failures roll back claims; migration reinstall retains proofs", async () => {
      await assert.rejects(connect(outsider, "300", "Valid#12345"), (error: any) => error.code === "42501");
      await assert.rejects(connect(alice, "bad", "Valid#12345"), (error: any) => error.code === "22023");
      await assert.rejects(connect(alice, "300", "BadTag"), (error: any) => error.code === "22023");
      await connect(alice, "101", "Legacy#12345");
      await db.exec(await readFile(oauthMigration, "utf8"));
      assert.equal((await profile()).is_verified, true);
      await actor(alice);
      await role("authenticated", () => db.query("select public.rename_player('Alice','NewDisplayName')"));
      assert.equal((await profile("NewDisplayName")).is_verified, true);
      assert.equal((await publicAccounts("NewDisplayName"))[0].battletag, "Legacy#12345");
    });
  } finally { await db.close(); }
});
}
