import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { rankPlayers, recordHolder } from "../supabase/functions/_shared/leaderboard.ts";
import { buildMatchImport, type ImportPlayer } from "../supabase/functions/_shared/import-stats.ts";
import { assignMatchId } from "../supabase/functions/_shared/match-upload.ts";

const alice = "00000000-0000-0000-0000-000000000001";
const bob = "00000000-0000-0000-0000-000000000002";
const admin = "00000000-0000-0000-0000-000000000003";
const pbMigration = "20261013180000_pb_rankings_and_records.sql";
const migration = (name: string) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

for (const accounts of ["text[]", "jsonb"]) {
test(`PB rankings remain authoritative across imports and account changes (${accounts})`, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${alice}'),('${bob}'),('${admin}');
      create table auth.identities(user_id uuid,provider text);
      insert into auth.identities values ('${alice}','discord'),('${bob}','discord'),('${admin}','discord');
      create table public.players(name text primary key,user_id uuid,is_admin boolean default false,
        bnet_accounts ${accounts} default '${accounts === "jsonb" ? "[]" : "{}"}',matches integer,score integer,deaths integer,
        kdr text,accuracy text,kpm text,crouches integer,time_in_lobby numeric,elo text,rank integer,tag text);
      create table public.player_matches(id bigint generated always as identity primary key,player_name text,
        score integer,deaths integer,accuracy numeric,kpm numeric,kdr numeric,crouches integer,time_in_lobby numeric,
        total_match_time integer,performance_score integer,created_at timestamptz default now());
      create table public.player_history(id bigint generated always as identity primary key,player_name text,
        elo integer,rank integer,created_at timestamptz default now());
      create table public.audit_logs(id bigint generated always as identity primary key,action text,admin_user text,details text);
      insert into public.players(name,user_id,is_admin,matches,elo) values ('Alice','${alice}',false,0,'-'),('Bob','${bob}',false,0,'-'),('Admin','${admin}',true,0,'-');
      alter table public.players enable row level security;
      create policy own_profile on public.players to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update on public.players to authenticated;
    `);
    for (const name of ["20261005210000_admin_leaderboard_reset.sql", "20261012110000_preserve_player_history_on_rename.sql",
      "20261012120000_add_match_date.sql", "20261012130000_count_imported_rounds.sql", "20261012140000_global_match_history.sql",
      "20261012220000_battlenet_oauth.sql", "20261013010000_battlenet_owned_profile_claims.sql",
      "20261013140000_verified_battlenet_claim_priority.sql"]) await db.exec(await migration(name));
    const asRole = async <T>(role: string, action: () => Promise<T>) => {
      await db.exec(`set role ${role}`); try { return await action(); } finally { await db.exec("reset role"); }
    };
    const actor = (id: string) => db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    const profile = async (name: string) => (await db.query<any>("select * from public.players where name=$1", [name])).rows[0];
    const makeMatch = (name: string, seconds: number, score = 50, total = 600) => assignMatchId([{
      player_name: name, score, deaths: 10, accuracy: 60, kpm: 20, kdr: 5,
      crouches: 100, time_in_lobby: seconds, total_match_time: total, played_at: "2026-10-13T12:00:00",
    }]);
    const importMatches = async (matches: ReturnType<typeof makeMatch>, oldClient = false) => {
      const payload = buildMatchImport((await db.query<ImportPlayer>("select * from public.players")).rows, matches);
      if (oldClient) {
        for (const p of payload.players) delete (p as any).personal_best_time;
        for (const h of payload.history) h.rank = 999999; // Simulate an old Edge deployment's stale positions.
      }
      const revision = (await db.query<any>("select revision from public.leaderboard_state where singleton")).rows[0].revision;
      await asRole("service_role", () => db.query("select public.apply_match_import($1,$2,$3,$4,$5,'TEST','PB')",
        [revision, ...[payload.players,payload.ranks,payload.history,payload.matches].map(x => JSON.stringify(x))]));
      return payload;
    };
    await importMatches([...makeMatch("Alice",180,50,190),...makeMatch("Bob",120,50,600),...makeMatch("NoWin",1,49),...makeMatch("Zero",0)]);
    await db.exec(await migration(pbMigration));

    await t.test("backfill uses personal time to 50 kills and agrees with the browser's PB tie-breaker", async () => {
      assert.equal(Number((await profile("Alice")).personal_best_time),180);
      assert.equal(Number((await profile("Bob")).personal_best_time),120);
      assert.equal((await profile("NoWin")).personal_best_time,null);
      assert.equal((await profile("Zero")).personal_best_time,null);
      const players = (await db.query<any>("select * from public.players where matches>0 order by rank")).rows;
      assert.deepEqual(players.map(p => p.name),rankPlayers(players).map(p => p.name));
      assert.equal(players[0].name,"Bob");
      assert.equal(recordHolder(players)?.name,"Bob");
    });

    await t.test("new PBs and history ranks are correct even when the deployed Edge Function supplies stale ranks", async () => {
      const payload = await importMatches(makeMatch("Alice",90),true);
      assert.equal(Number((await profile("Alice")).personal_best_time),90);
      assert.equal((await profile("Alice")).rank,1);
      const last = (await db.query<any>("select * from public.player_history where player_name='Alice' order by id desc limit 1")).rows[0];
      assert.equal(last.rank,1);
      await importMatches(makeMatch("Alice",5,49));
      assert.equal(Number((await profile("Alice")).personal_best_time),90);
      const before = (await profile("Alice")).personal_best_time;
      await importMatches(makeMatch("Alice",95));
      assert.equal((await profile("Alice")).personal_best_time,before);
      assert.equal(payload.matches[0].total_match_time,600);
    });

    await t.test("browser writes cannot award a faster PB or invoke the private maintenance functions", async () => {
      await actor(alice);
      await asRole("authenticated", () => db.query("update public.players set personal_best_time=1 where name='Alice'"));
      assert.equal(Number((await profile("Alice")).personal_best_time),90);
      for (const role of ["anon","authenticated","service_role"]) {
        for (const sql of ["select public._rerank_players_by_pb()","select public._refresh_player_personal_bests()"])
          await assert.rejects(asRole(role, () => db.query(sql)),(e: any) => e.code === "42501");
      }
    });

    await t.test("correcting and deleting winning rows recalculates PBs without using losses", async () => {
      await db.query("update public.player_matches set time_in_lobby=160 where player_name='Alice' and time_in_lobby=90");
      assert.equal(Number((await profile("Alice")).personal_best_time),95);
      await db.query("delete from public.player_matches where player_name='Alice' and time_in_lobby=95");
      assert.equal(Number((await profile("Alice")).personal_best_time),160);
      await db.query("update public.players set elo='1,000' where name in ('Alice','Bob')");
      await db.query("select public._rerank_players_by_pb()");
      assert.ok((await profile("Bob")).rank < (await profile("Alice")).rank);
    });

    await t.test("OAuth merges and profile renames retain the fastest winning time", async () => {
      await importMatches(makeMatch("ImportedSpeed",80));
      await asRole("service_role", () => db.query("select public.complete_battlenet_account_link($1,'100','ImportedSpeed#12345')",[alice]));
      assert.equal(await profile("ImportedSpeed"),undefined);
      assert.equal(Number((await profile("Alice")).personal_best_time),80);
      await actor(alice);
      await asRole("authenticated", () => db.query("select public.rename_player('Alice','Zed')"));
      assert.equal(Number((await profile("Zed")).personal_best_time),80);
      await importMatches(makeMatch("ImportedSpeed",70));
      assert.equal(Number((await profile("Zed")).personal_best_time),70);
      assert.equal(recordHolder((await db.query<any>("select * from public.players")).rows)?.name,"Zed");
    });

    await t.test("a verified claim transfers its PB out of a foreign unverified manual claim", async () => {
      await importMatches(makeMatch("ManualFast",60));
      await db.query("select public._link_bnet_account_impl($1,'Bob','ManualFast',false)",[bob]);
      assert.equal(Number((await profile("Bob")).personal_best_time),60);
      await asRole("service_role", () => db.query("select public.complete_battlenet_account_link($1,'101','ManualFast#12345')",[alice]));
      assert.equal(Number((await profile("Zed")).personal_best_time),60);
      assert.equal(Number((await profile("Bob")).personal_best_time),120);
      assert.equal((await profile("Bob")).user_id,bob);
      assert.equal(recordHolder((await db.query<any>("select * from public.players")).rows)?.name,"Zed");
    });

    await t.test("reinstall is safe and a leaderboard reset clears all records", async () => {
      const before = (await db.query<any>("select name,personal_best_time from public.players order by name")).rows;
      await db.exec(await migration(pbMigration));
      assert.deepEqual((await db.query<any>("select name,personal_best_time from public.players order by name")).rows,before);
      await actor(admin);
      await asRole("authenticated", () => db.query("select public.reset_leaderboard('RESET')"));
      const profiles = (await db.query<any>("select * from public.players")).rows;
      assert.ok(profiles.every(p => p.personal_best_time === null));
      assert.equal(recordHolder(profiles),null);
      assert.equal((await profile("Zed")).is_verified,true);
    });
  } finally { await db.close(); }
});
}
