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
const ownClaimsMigration = new URL("../supabase/migrations/20261013010000_battlenet_owned_profile_claims.sql", import.meta.url);
const priorityMigration = new URL("../supabase/migrations/20261013140000_verified_battlenet_claim_priority.sql", import.meta.url);

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
    const createOwner = async (name: string, userId: string) => {
      await db.query("insert into auth.users values ($1)", [userId]);
      await db.query("insert into auth.identities values ($1,'discord')", [userId]);
      await actor(userId);
      return (await role("authenticated", () => db.query<any>(
        "select public.ensure_discord_player($1) as data", [name]))).rows[0].data.name as string;
    };
    const profile = async (name = "Alice") => (await db.query<any>("select * from public.players where name = $1", [name])).rows[0];
    const connect = (userId: string, id: string, tag: string) => role("service_role", () => db.query(
      "select public.complete_battlenet_account_link($1, $2, $3)", [userId, id, tag]));
    const publicAccounts = async (name = "Alice") => (await role("anon", () => db.query<{ data: any[] }>(
      "select public.get_player_bnet_accounts($1) as data", [name]))).rows[0].data;
    const importMatch = async (name: string, values: Partial<{ score: number; deaths: number; accuracy: number;
      kpm: number; kdr: number; crouches: number; time_in_lobby: number }> = {}) => {
      const matches = assignMatchId([{ player_name: name, score: 50, deaths: 10, accuracy: 60,
        kpm: 20, kdr: 5, crouches: 100, time_in_lobby: 149, total_match_time: 160, played_at: "2026-10-12T20:00:00", ...values }]);
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
    await db.exec(await readFile(ownClaimsMigration, "utf8"));
    await db.exec(await readFile(priorityMigration, "utf8"));

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
          `select public._release_unverified_bnet_name('${alice}','Alice','Legacy')`,
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
      await connect(alice, "101", "Legacy#12345");
      await assert.rejects(connect(bob, "200", "battlealice#98765"), (error: any) => error.code === "23505");
      await assert.rejects(connect(bob, "100", "Different#98765"), (error: any) => error.code === "23505");
      await assert.rejects(connect(bob, "201", "Legacy#98765"), (error: any) => error.code === "23505");
      assert.equal((await profile("Bob")).is_verified, false);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links")).rows[0].n, 2);
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

    await t.test("an own admin profile is merged instead of rejected, and unlinking permits reverification", async () => {
      await db.query("insert into public.players(name,user_id,is_admin,matches,elo) values ('Bobby',$1,true,0,'-')", [bob]);
      await connect(bob, "200", "Bobby#12345");
      assert.equal(await profile("Bobby"), undefined);
      assert.equal((await profile("Bob")).is_admin, true);
      assert.equal((await profile("Bob")).is_verified, true);
      assert.ok((await profile("Bob")).previous_names.includes("Bobby"));
      await actor(bob);
      await role("authenticated", () => db.query("select public.link_bnet_account('Bob','Bobby',true)"));
      assert.equal((await profile("Bob")).is_verified, false);
      await connect(bob, "200", "Bobby#12345");
      assert.equal((await profile("Bob")).is_verified, true);
      await assert.rejects(connect(alice, "201", "Bobby#98765"), (error: any) => error.code === "23505");
    });

    await t.test("own legacy duplicates retain other accounts, weighted stats, logged names and admin rights", async () => {
      const round = await importMatch("AliceOld");
      await db.query("update public.players set user_id=$1,is_admin=true,bnet_accounts=$2 where name='AliceOld'",
        [alice, accountColumn === "jsonb" ? JSON.stringify(["KeptAccount"]) : ["KeptAccount"]]);
      const before = await profile(); const donor = await profile("AliceOld");
      await connect(alice, "800", "AliceOld#12345");
      const merged = await profile();
      assert.equal(await profile("AliceOld"), undefined);
      assert.equal(merged.matches, before.matches + donor.matches);
      assert.equal(merged.score, (before.score ?? 0) + donor.score);
      assert.equal(Number(merged.time_in_lobby), Number(before.time_in_lobby ?? 0) + Number(donor.time_in_lobby));
      assert.equal(merged.kdr, ((Number(before.kdr) * before.matches + Number(donor.kdr) * donor.matches) / merged.matches).toFixed(2));
      assert.deepEqual(merged.bnet_accounts, ["AliceOld", "KeptAccount"]);
      assert.equal(merged.is_admin, true);
      const match = (await db.query<any>("select player_name,logged_player_name from public.player_matches where match_id=$1", [round])).rows[0];
      assert.deepEqual(match, { player_name: "Alice", logged_player_name: "AliceOld" });
      assert.ok((await db.query<any>("select count(*)::int as n from public.player_history where player_name='Alice'")).rows[0].n > 0);
      await connect(alice, "803", "KeptAccount#12345");
      await assert.rejects(connect(bob, "801", "KeptAccount#98765"), (error: any) => error.code === "23505");
      await actor(alice);
      for (const account of ["AliceOld", "KeptAccount"]) {
        await role("authenticated", () => db.query("select public.link_bnet_account('Alice',$1,true)", [account]));
      }
      await importMatch("AliceOld");
      assert.equal((await profile()).matches, merged.matches + 1);
    });

    await t.test("merging an own duplicate cannot silently discard a third linked account", async () => {
      await db.query("insert into public.players(name,user_id,matches,elo,bnet_accounts) values ('AliceOverflow',$1,0,'-',$2)",
        [alice, accountColumn === "jsonb" ? JSON.stringify(["ExtraOne", "ExtraTwo"]) : ["ExtraOne", "ExtraTwo"]]);
      const before = await profile(); const donor = await profile("AliceOverflow");
      await assert.rejects(connect(alice, "802", "AliceOverflow#12345"), (error: any) => error.code === "22023");
      assert.deepEqual(await profile(), before);
      assert.deepEqual(await profile("AliceOverflow"), donor);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links where account_id='802'")).rows[0].n, 0);
    });

    await t.test("a new Discord user can verify an existing imported name and then use it as display name", async () => {
      const userId = "00000000-0000-0000-0000-000000000010";
      const round = await importMatch("ImportFirst");
      const name = await createOwner("ImportFirst", userId);
      assert.notEqual(name, "ImportFirst");
      await connect(userId, "1000", "ImportFirst#12345");
      assert.equal(await profile("ImportFirst"), undefined);
      assert.equal((await profile(name)).is_verified, true);
      assert.equal((await profile(name)).matches, 1);
      assert.equal((await db.query<any>("select player_name from public.player_matches where match_id=$1", [round])).rows[0].player_name, name);
      await actor(userId);
      await role("authenticated", () => db.query("select public.rename_player($1,'ImportFirst')", [name]));
      await importMatch("ImportFirst");
      assert.equal((await profile("ImportFirst")).matches, 2);
    });

    await t.test("a verified claim displaces a foreign manual slot without taking its Discord profile, other matches or admin rights", async () => {
      const legacyUser = "00000000-0000-0000-0000-000000000011";
      const verifiedUser = "00000000-0000-0000-0000-000000000012";
      await createOwner("LegacyOwner", legacyUser);
      await createOwner("VerifiedOwner", verifiedUser);
      const reclaimedRound = await importMatch("Reclaimable");
      const otherRound = await importMatch("Unrelated", { score: 10, kdr: 1, accuracy: 40, kpm: 8, crouches: 20, time_in_lobby: 60 });
      // Reproduce pre-OAuth manual claims using the private legacy helper.
      for (const account of ["Reclaimable", "Unrelated"]) {
        await db.query("select public._link_bnet_account_impl($1,'LegacyOwner',$2,false)", [legacyUser, account]);
      }
      await db.query("update public.players set is_admin=true where name='LegacyOwner'");
      const rowsBefore = (await db.query<any>("select count(*)::int as n from public.player_matches")).rows[0].n;
      const historyBefore = (await db.query<any>("select count(*)::int as n from public.player_history where player_name='LegacyOwner'")).rows[0].n;
      await connect(verifiedUser, "1100", "reCLAIMable#12345");
      const old = await profile("LegacyOwner"); const owner = await profile("VerifiedOwner");
      assert.equal(old.user_id, legacyUser); assert.equal(old.is_admin, true);
      assert.equal(owner.user_id, verifiedUser); assert.equal(owner.is_admin, false);
      assert.deepEqual(old.bnet_accounts, ["Unrelated"]);
      assert.ok(!old.previous_names.some((name: string) => name.toLowerCase() === "reclaimable"));
      assert.equal(old.matches, 1); assert.equal(old.score, 10); assert.equal(old.deaths, 10);
      assert.equal(old.kdr, "1.00"); assert.equal(old.accuracy, "40.00%"); assert.equal(old.kpm, "8.00");
      assert.equal(old.crouches, 20); assert.equal(Number(old.time_in_lobby), 60); assert.equal(old.elo, "512");
      assert.equal(owner.matches, 1); assert.equal(owner.score, 50); assert.equal(owner.is_verified, true);
      assert.equal(Number(owner.time_in_lobby), 149);
      assert.equal(owner.kdr, "5.00"); assert.equal(owner.accuracy, "60.00%"); assert.equal(owner.kpm, "20.00");
      assert.equal(owner.crouches, 100); assert.equal(owner.elo, "1,163");
      assert.equal((await db.query<any>("select player_name,logged_player_name from public.player_matches where match_id=$1", [reclaimedRound])).rows[0].player_name, owner.name);
      assert.equal((await db.query<any>("select player_name from public.player_matches where match_id=$1", [otherRound])).rows[0].player_name, old.name);
      assert.equal((await db.query<any>("select count(*)::int as n from public.player_matches")).rows[0].n, rowsBefore);
      assert.equal((await db.query<any>("select count(*)::int as n from public.player_history where player_name='LegacyOwner'")).rows[0].n, historyBefore);
      await importMatch("Reclaimable"); await importMatch("Unrelated");
      assert.equal((await profile("VerifiedOwner")).matches, 2);
      assert.equal((await profile("LegacyOwner")).matches, 2);
      const before = await profile("LegacyOwner");
      await assert.rejects(connect(legacyUser, "1101", "Reclaimable#98765"), (error: any) => error.code === "23505");
      assert.deepEqual(await profile("LegacyOwner"), before);
    });

    await t.test("a matching foreign display name is freed while its unrelated verified account stays verified", async () => {
      const oldUser = "00000000-0000-0000-0000-000000000013";
      const newUser = "00000000-0000-0000-0000-000000000014";
      await createOwner("NameOnly", oldUser);
      await createOwner("NewNameOwner", newUser);
      await importMatch("NameOnly");
      await importMatch("OtherVerified");
      await connect(oldUser, "1200", "OtherVerified#12345");
      await connect(newUser, "1201", "NameOnly#12345");
      assert.equal(await profile("NameOnly"), undefined);
      const old = (await db.query<any>("select * from public.players where user_id=$1", [oldUser])).rows[0];
      assert.equal(old.name, "NameOnly (profile 1)");
      assert.equal(old.is_verified, true); assert.equal(old.matches, 1);
      assert.deepEqual(old.bnet_accounts, ["OtherVerified"]);
      assert.ok(!old.previous_names.includes("NameOnly"));
      assert.equal((await profile("NewNameOwner")).matches, 1);
      assert.equal((await publicAccounts(old.name))[0].battletag, "OtherVerified#12345");
      await actor(oldUser);
      await assert.rejects(role("authenticated", () => db.query("select public.rename_player($1,'NameOnly')", [old.name])), (error: any) => error.code === "23505");
      await actor(newUser);
      await role("authenticated", () => db.query("select public.rename_player('NewNameOwner','NameOnly')"));
      await importMatch("NameOnly"); await importMatch("OtherVerified");
      assert.equal((await profile("NameOnly")).matches, 2);
      assert.equal((await profile(old.name)).matches, 2);
    });

    await t.test("a third-account failure rolls back displacement, stats and the foreign display-name change", async () => {
      const oldUser = "00000000-0000-0000-0000-000000000015";
      const newUser = "00000000-0000-0000-0000-000000000016";
      await createOwner("RollbackName", oldUser);
      await createOwner("FullOwner", newUser);
      await importMatch("RollbackName");
      await connect(newUser, "1300", "FullOne#12345");
      await connect(newUser, "1301", "FullTwo#12345");
      const oldBefore = await profile("RollbackName"); const newBefore = await profile("FullOwner");
      const matchesBefore = (await db.query<any>("select * from public.player_matches where player_name='RollbackName'")).rows;
      await assert.rejects(connect(newUser, "1302", "RollbackName#12345"), (error: any) => error.code === "22023");
      assert.deepEqual(await profile("RollbackName"), oldBefore);
      assert.deepEqual(await profile("FullOwner"), newBefore);
      assert.deepEqual((await db.query<any>("select * from public.player_matches where player_name='RollbackName'")).rows, matchesBefore);
      assert.equal((await db.query<any>("select count(*)::int as n from public.battlenet_account_links where account_id='1302'")).rows[0].n, 0);
    });

    await t.test("reverifying an existing manual slot at the two-account limit releases duplicate claims atomically", async () => {
      const oldUser = "00000000-0000-0000-0000-000000000017";
      const newUser = "00000000-0000-0000-0000-000000000018";
      await createOwner("DuplicateOldOwner", oldUser);
      await createOwner("DuplicateNewOwner", newUser);
      await importMatch("DuplicateSlot");
      await db.query("select public._link_bnet_account_impl($1,'DuplicateOldOwner','DuplicateSlot',false)", [oldUser]);
      // A legacy database could have duplicate manual entries before OAuth.
      await db.query("update public.players set bnet_accounts=$1 where name='DuplicateNewOwner'",
        [accountColumn === "jsonb" ? JSON.stringify(["DuplicateSlot", "RemainingSlot"]) : ["DuplicateSlot", "RemainingSlot"]]);
      await connect(newUser, "1400", "DuplicateSlot#12345");
      const old = await profile("DuplicateOldOwner"); const owner = await profile("DuplicateNewOwner");
      assert.deepEqual(old.bnet_accounts, []); assert.equal(old.matches, 0); assert.equal(old.rank, 999999);
      assert.deepEqual(owner.bnet_accounts, ["DuplicateSlot", "RemainingSlot"]);
      assert.equal(owner.matches, 1); assert.equal(owner.is_verified, true);
      assert.ok(owner.rank < 999999);
      const before = await profile("DuplicateNewOwner");
      await connect(newUser, "1400", "DuplicateSlot#12345");
      assert.deepEqual(await profile("DuplicateNewOwner"), before);
    });

    await t.test("freeing an unverified admin display name preserves its identity and admin permission", async () => {
      const oldUser = "00000000-0000-0000-0000-000000000019";
      const newUser = "00000000-0000-0000-0000-000000000020";
      await createOwner("AdminDisplay", oldUser); await createOwner("VerifiedAdminNameOwner", newUser);
      await importMatch("AdminDisplay");
      await db.query("update public.players set is_admin=true where name='AdminDisplay'");
      await importMatch("AdminDisplay (profile 1)");
      await connect(newUser, "1500", "AdminDisplay#12345");
      const old = await profile("AdminDisplay (profile 2)"); const owner = await profile("VerifiedAdminNameOwner");
      assert.equal(old.user_id, oldUser); assert.equal(old.is_admin, true); assert.equal(old.matches, 0);
      assert.equal(owner.user_id, newUser); assert.equal(owner.is_admin, false); assert.equal(owner.matches, 1);
      assert.equal((await profile("AdminDisplay (profile 1)")).matches, 1);
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
      await db.exec(await readFile(ownClaimsMigration, "utf8"));
      await db.exec(await readFile(priorityMigration, "utf8"));
      assert.equal((await profile()).is_verified, true);
      await actor(alice);
      await role("authenticated", () => db.query("select public.rename_player('Alice','NewDisplayName')"));
      assert.equal((await profile("NewDisplayName")).is_verified, true);
      assert.equal((await publicAccounts("NewDisplayName"))[0].battletag, "Legacy#12345");
    });
  } finally { await db.close(); }
});
}
