import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createBattleNetOAuthHandler, readBattleNetIdentity, type OAuthRequest } from "../supabase/functions/_shared/battlenet-oauth.ts";

const callbackUrl = "https://project.supabase.co/functions/v1/battlenet-oauth/callback";
const verifier = "b".repeat(64);
const baseUrl = "https://site.test/widowhs/";
const fixture = () => {
  const states = new Map<string, OAuthRequest>();
  const linked: any[] = [];
  const finished: any[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  let identity: any = { sub: "123456789", id: 123456789, battletag: "Лев#12345" };
  let failure: any = null;
  let createFailure: any = null;
  let providerFailure = false;
  const handler = createBattleNetOAuthHandler({
    config: { clientId: "client-id", clientSecret: "test-secret", callbackUrl, redirectUrls: [baseUrl, "http://localhost:4173/"] },
    store: {
      getUser: async token => token === "discord-session" ? "discord-user" : null,
      createRequest: async (hash, userId, redirectUrl, browserHash) => {
        if (createFailure) throw createFailure;
        states.set(hash, { user_id: userId, redirect_url: redirectUrl, browser_hash: browserHash });
      },
      consumeRequest: async hash => { const value = states.get(hash); states.delete(hash); return value ?? null; },
      saveResult: async (_hash, pending, value) => { if (failure) throw failure; linked.push({ userId: pending.user_id, value }); },
      completeResult: async (hash, userId, browserHash) => { if (failure) throw failure; finished.push({ hash, userId, browserHash }); },
    },
    fetcher: async (input, options) => {
      const url = String(input); requests.push({ url, options: options! });
      if (providerFailure) return new Response("provider secret error", { status: 503 });
      return Response.json(url.endsWith("/token") ? { access_token: "provider-access-token", token_type: "bearer" } : identity);
    },
  });
  const start = (body: any = { redirectUrl: baseUrl }, token = "discord-session", origin = "https://site.test") => handler(new Request(
    "https://project.supabase.co/functions/v1/battlenet-oauth", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ verifier, ...body }) }));
  const authorization = async () => new URL((await (await start()).json()).url);
  const callback = (state: string, extra = "code=provider-code") => handler(new Request(`${callbackUrl}?state=${state}&${extra}`));
  return { states, linked, finished, requests, handler, start, authorization, callback,
    setIdentity: (value: any) => { identity = value; }, setFailure: (value: any) => { failure = value; },
    setCreateFailure: (value: any) => { createFailure = value; }, failProvider: () => { providerFailure = true; } };
};

test("OAuth starts only for a validated user and an exact configured return URL", async () => {
  const f = fixture();
  assert.equal((await f.start(undefined, "bad-session")).status, 401);
  for (const redirectUrl of ["https://evil.test/", `${baseUrl}?next=evil`, `${baseUrl}#/admin`, "https://site.test/other/", "javascript:alert(1)"]) {
    assert.equal((await f.start({ redirectUrl })).status, 400);
  }
  assert.equal((await f.start(undefined, undefined, "https://evil.test")).status, 403);
  assert.equal(f.states.size, 0);
  const auth = await f.authorization();
  assert.equal(auth.origin, "https://oauth.battle.net");
  assert.equal(auth.pathname, "/authorize");
  assert.equal(auth.searchParams.get("redirect_uri"), callbackUrl);
  assert.equal(auth.searchParams.get("scope"), "openid");
  assert.equal(auth.searchParams.get("response_type"), "code");
  const state = auth.searchParams.get("state")!;
  assert.match(state, /^[a-f0-9]{64}$/);
  assert.equal(f.states.has(state), false);
  assert.deepEqual(f.states.get(createHash("sha256").update(state).digest("hex")), { user_id: "discord-user", redirect_url: baseUrl, browser_hash: createHash("sha256").update(verifier).digest("hex") });
  assert.ok(!auth.href.includes("test-secret"));
});

test("callback prepares Blizzard's identity for the original Discord user and keeps credentials server-side", async () => {
  const f = fixture(); const auth = await f.authorization();
  const response = await f.callback(auth.searchParams.get("state")!);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${baseUrl}#/profile/me?bnet=confirm&ticket=${auth.searchParams.get("state")}`);
  assert.deepEqual(f.linked, [{ userId: "discord-user", value: { accountId: "123456789", battleTag: "Лев#12345", logName: "Лев" } }]);
  assert.equal(f.requests[0].url, "https://oauth.battle.net/token");
  assert.equal((f.requests[0].options.headers as any).Authorization, `Basic ${btoa("client-id:test-secret")}`);
  assert.equal(new URLSearchParams(String(f.requests[0].options.body)).get("redirect_uri"), callbackUrl);
  assert.equal(f.requests[1].url, "https://oauth.battle.net/userinfo");
  assert.equal((f.requests[1].options.headers as any).Authorization, "Bearer provider-access-token");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!JSON.stringify([...response.headers]).includes("provider-access-token"));
  assert.equal(f.finished.length, 0);
});

test("finishing requires a validated Discord session, ticket and browser verifier", async () => {
  const f = fixture(); const ticket = "f".repeat(64);
  const complete = (body: any = {}, token = "discord-session") => f.start({ action: "complete", ticket, verifier, ...body }, token);
  assert.equal((await complete({}, "bad-session")).status, 401);
  assert.equal((await complete({ ticket: "bad" })).status, 400);
  assert.equal((await complete({ verifier: "bad" })).status, 400);
  assert.equal(f.finished.length, 0);
  assert.equal((await complete()).status, 200);
  assert.deepEqual(f.finished, [{ hash: createHash("sha256").update(ticket).digest("hex"), userId: "discord-user",
    browserHash: createHash("sha256").update(verifier).digest("hex") }]);
  f.setFailure({ code: "23505" }); assert.equal((await (await complete()).json()).error, "claimed");
  f.setFailure({ code: "42501" }); assert.equal((await complete()).status, 403);
});

test("unknown, missing and replayed state cannot exchange tokens; simultaneous callbacks have one winner", async () => {
  const f = fixture();
  assert.equal((await f.callback("")).status, 400);
  assert.equal((await f.callback("a".repeat(64))).status, 400);
  assert.equal(f.requests.length, 0);
  const state = (await f.authorization()).searchParams.get("state")!;
  const responses = await Promise.all([f.callback(state), f.callback(state)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [303, 400]);
  assert.equal(f.linked.length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.callback(state)).status, 400);
});

test("cancellation consumes state and returns to the profile without changing accounts", async () => {
  const f = fixture(); const state = (await f.authorization()).searchParams.get("state")!;
  const response = await f.callback(state, "error=access_denied&error_description=untrusted");
  assert.equal(response.headers.get("location"), `${baseUrl}#/profile/me?bnet=cancelled`);
  assert.equal(f.linked.length, 0); assert.equal(f.requests.length, 0);
  assert.equal((await f.callback(state)).status, 400);
});

test("claimed names, account limits and provider failures use fixed safe messages", async () => {
  for (const [code, expected] of [["23505", "claimed"], ["22023", "limit"], ["42501", "failed"]]) {
    const f = fixture(); f.setFailure({ code, message: "sensitive SQL details" });
    const state = (await f.authorization()).searchParams.get("state")!;
    assert.equal((await f.callback(state)).headers.get("location"), `${baseUrl}#/profile/me?bnet=${expected}`);
    assert.equal(f.linked.length, 0);
  }
  const f = fixture(); f.failProvider(); const state = (await f.authorization()).searchParams.get("state")!;
  assert.equal((await f.callback(state)).headers.get("location"), `${baseUrl}#/profile/me?bnet=failed`);
  assert.equal(f.linked.length, 0);
});

test("identity validation rejects forged/incomplete or inconsistent provider responses", async () => {
  for (const identity of [null, {}, { sub: "123", battletag: "name" }, { sub: "123", id: 124, battletag: "name#1234" },
    { sub: "evil", battletag: "name#1234" }, { sub: "123", battletag: "name\n#1234" }]) {
    assert.throws(() => readBattleNetIdentity(identity));
    const f = fixture(); f.setIdentity(identity); const state = (await f.authorization()).searchParams.get("state")!;
    assert.equal((await f.callback(state)).headers.get("location"), `${baseUrl}#/profile/me?bnet=failed`);
    assert.equal(f.linked.length, 0);
  }
  assert.equal(readBattleNetIdentity({ sub: "9007199254740993123", battletag: "FearMyHanzo#12345" }).accountId, "9007199254740993123");
});

test("Discord checks, rate limits and missing configuration fail without creating usable login URLs", async () => {
  const f = fixture();
  f.setCreateFailure({ code: "42501" }); assert.equal((await f.start()).status, 403);
  f.setCreateFailure({ code: "54000" }); assert.equal((await f.start()).status, 429);
  assert.equal(f.states.size, 0);
  const handler = createBattleNetOAuthHandler({ config: { clientId: "", clientSecret: "", callbackUrl: "", redirectUrls: [] }, store: {} as any });
  assert.equal((await handler(new Request(callbackUrl))).status, 503);
  assert.equal((await handler(new Request(callbackUrl, { method: "OPTIONS" }))).status, 200);
});
