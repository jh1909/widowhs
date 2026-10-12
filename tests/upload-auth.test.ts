import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import Papa from "papaparse";
import { normalizeMatchLog, parseMatchRows } from "../supabase/functions/upload-csv/parser.ts";
import { readMatchSources, assignMatchId } from "../supabase/functions/_shared/match-upload.ts";
import { buildMatchImport } from "../supabase/functions/_shared/import-stats.ts";

test("upload endpoint requires an automation key or a validated admin session", async t => {
  const source = await readFile(new URL("../supabase/functions/upload-csv/index.ts", import.meta.url), "utf8");
  const { code } = await transform(source.replace(/^import .+;\r?\n/gm, ""), { loader: "ts", format: "cjs" });
  let handler: (request: Request) => Promise<Response>;
  let key: string | undefined = "test-key";
  let admin = false;
  let authenticated = false;
  let written: any = null;
  const client = {
    auth: { getUser: async (token: string) => ({ data: { user: authenticated && token === "valid-token" ? { id: "actor" } : null }, error: null }) },
    from: (table: string) => {
      let adminQuery = false;
      const result = () => ({ data: table === "leaderboard_state" ? { revision: 0 }
        : table === "players" && adminQuery && admin ? [{ name: "Admin" }] : [], error: null });
      const query: any = { select: () => query, eq: (field: string) => { if (field === "is_admin") adminQuery = true; return query; },
        order: () => query, range: async () => result(), limit: async () => result(), single: async () => result() };
      return query;
    },
    rpc: async (_name: string, payload: unknown) => { written = payload; return { error: null }; },
  };
  runInNewContext(code, {
    serve: (callback: typeof handler) => { handler = callback; }, createClient: () => client,
    Deno: { env: { get: (name: string) => name === "ADMIN_API_KEY" ? key : "test-env" } },
    normalizeMatchLog, parseMatchRows, readMatchSources, assignMatchId, buildMatchImport, Papa,
    Response, console,
  });
  const request = (headers: Record<string, string> = {}) => new Request("https://example.test/upload", {
    method: "POST", headers, body: "NewPlayer,50,10,60,20,5,120,149,160",
  });
  await t.test("anonymous requests, bad keys and invalid sessions cannot write", async () => {
    assert.equal((await handler(request())).status, 401);
    assert.equal((await handler(request({ "x-api-key": "wrong" }))).status, 401);
    assert.equal((await handler(request({ Authorization: "Bearer invalid" }))).status, 401);
    key = undefined;
    assert.equal((await handler(request())).status, 401);
    assert.equal(written, null);
  });
  await t.test("a signed-in non-admin is denied", async () => {
    authenticated = true;
    assert.equal((await handler(request({ Authorization: "Bearer valid-token" }))).status, 403);
    assert.equal(written, null);
  });
  await t.test("a server-validated admin imports an unregistered player", async () => {
    admin = true;
    const response = await handler(request({ Authorization: "Bearer valid-token" }));
    assert.equal(response.status, 200);
    assert.equal(written.p_players[0].name, "NewPlayer");
    assert.equal(written.p_matches[0].logged_player_name, "NewPlayer");
    assert.equal(written.p_matches.length, 1);
  });
  await t.test("automation with the configured key still works without a login", async () => {
    authenticated = false; admin = false; key = "test-key"; written = null;
    assert.equal((await handler(request({ "x-api-key": key }))).status, 200);
    assert.equal(written.p_matches.length, 1);
  });
  await t.test("CORS preflight stays available without authentication", async () => {
    assert.equal((await handler(new Request("https://example.test/upload", { method: "OPTIONS" }))).status, 200);
  });
});
