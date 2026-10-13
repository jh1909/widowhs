export const BNET_ISSUER = "https://oauth.battle.net";

export type BattleNetIdentity = { accountId: string; battleTag: string; logName: string };
export type OAuthRequest = { user_id: string; redirect_url: string; browser_hash: string };
export type BattleNetOAuthStore = {
  getUser: (token: string) => Promise<string | null>;
  createRequest: (hash: string, userId: string, redirectUrl: string, browserHash: string) => Promise<void>;
  consumeRequest: (hash: string) => Promise<OAuthRequest | null>;
  saveResult: (hash: string, request: OAuthRequest, identity: BattleNetIdentity) => Promise<void>;
  completeResult: (hash: string, userId: string, browserHash: string) => Promise<void>;
};
export type BattleNetOAuthConfig = {
  clientId: string; clientSecret: string; callbackUrl: string; redirectUrls: string[];
};

export function readBattleNetIdentity(value: unknown): BattleNetIdentity {
  if (!value || typeof value !== "object") throw new Error("invalid_identity");
  const data = value as Record<string, unknown>;
  // Request openid so the provider's subject is the account identifier.
  // Never convert a large numeric ID through Number (loss of precision).
  const accountId = typeof data.sub === "string" ? data.sub : "";
  const battleTag = typeof data.battletag === "string" ? data.battletag : "";
  const match = /^([^#\s][^#\r\n]{0,63})#([0-9]{3,12})$/u.exec(battleTag);
  if (!/^[0-9]{1,30}$/.test(accountId) || !match || match[1].trim() !== match[1]) {
    throw new Error("invalid_identity");
  }
  if (data.id !== undefined && String(data.id) !== accountId) throw new Error("invalid_identity");
  return { accountId, battleTag, logName: match[1] };
}

async function stateHash(state: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function createBattleNetOAuthHandler({ config, store, fetcher = fetch }: {
  config: BattleNetOAuthConfig; store: BattleNetOAuthStore; fetcher?: typeof fetch;
}) {
  const allowed = new Set(config.redirectUrls.filter(raw => {
    try {
      const url = new URL(raw);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    } catch { return false; }
  }).map(raw => new URL(raw).href));
  const origins = new Set([...allowed].map(raw => new URL(raw).origin));
  const json = (request: Request, status: number, body: unknown) => {
    const origin = request.headers.get("origin");
    return new Response(JSON.stringify(body), { status, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin",
      ...(origin && origins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    } });
  };
  const redirect = (base: string, result: string, ticket?: string) => {
    const url = new URL(base);
    url.hash = `/profile/me?bnet=${encodeURIComponent(result)}${ticket ? `&ticket=${ticket}` : ""}`;
    return new Response(null, { status: 303, headers: {
      Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  };
  const providerJson = async (url: string, options: RequestInit) => {
    const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("provider_error");
    return response.json();
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const callback = url.pathname.endsWith("/battlenet-oauth/callback");
    if (request.method === "OPTIONS") return json(request, 200, { ok: true });
    if (!config.clientId || !config.clientSecret || !config.callbackUrl || allowed.size === 0) {
      return json(request, 503, { error: "Battle.net linking is not configured yet." });
    }
    if (callback) {
      if (request.method !== "GET") return json(request, 405, { error: "Method not allowed." });
      const state = url.searchParams.get("state") ?? "";
      if (!/^[0-9a-f]{64}$/.test(state)) return json(request, 400, { error: "Invalid or expired Battle.net link. Start again from your profile." });
      let pending: OAuthRequest | null;
      try { pending = await store.consumeRequest(await stateHash(state)); }
      catch { return json(request, 503, { error: "Could not validate your link. Please start again." }); }
      // Atomic consume happens BEFORE token exchange: no replay or double linking.
      if (!pending || !allowed.has(pending.redirect_url)) {
        return json(request, 400, { error: "Invalid or expired Battle.net link. Start again from your profile." });
      }
      if (url.searchParams.has("error")) return redirect(pending.redirect_url, "cancelled");
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) return redirect(pending.redirect_url, "failed");
      try {
        const token = await providerJson(`${BNET_ISSUER}/token`, {
          method: "POST", headers: {
            Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.callbackUrl }),
        });
        if (typeof token.access_token !== "string" || token.token_type?.toLowerCase() !== "bearer") throw new Error("provider_error");
        const identity = readBattleNetIdentity(await providerJson(`${BNET_ISSUER}/userinfo`, {
          method: "GET", headers: { Authorization: `Bearer ${token.access_token}` },
        }));
        await store.saveResult(await stateHash(state), pending, identity);
        // The callback does not claim anything yet. Only the initiating browser
        // can finish, using its session-local verifier AND the same Discord JWT.
        // This prevents sharing a login URL to link a victim's BNet to an attacker.
        return redirect(pending.redirect_url, "confirm", state);
      } catch (error) {
        // Only fixed status codes go to the browser. No provider tokens, codes,
        // SQL details or account IDs appear in redirects, logs or API responses.
        const code = (error as { code?: string }).code;
        const result = code === "23505" ? "claimed" : code === "22023" ? "limit" : "failed";
        return redirect(pending.redirect_url, result);
      }
    }
    if (!url.pathname.endsWith("/battlenet-oauth") || request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed." });
    }
    const origin = request.headers.get("origin");
    if (origin && !origins.has(origin)) return json(request, 403, { error: "This website is not enabled for Battle.net linking." });
    const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return json(request, 401, { error: "Please sign in with Discord first." });
    try {
      const userId = await store.getUser(token);
      if (!userId) return json(request, 401, { error: "Please sign in with Discord first." });
      const body = await request.json();
      if (body.action === "complete") {
        if (!/^[0-9a-f]{64}$/.test(body.ticket ?? "") || !/^[0-9a-f]{64}$/.test(body.verifier ?? "")) {
          return json(request, 400, { error: "invalid_link" });
        }
        try {
          await store.completeResult(await stateHash(body.ticket), userId, await stateHash(body.verifier));
          return json(request, 200, { result: "success" });
        } catch (error) {
          const code = (error as { code?: string }).code;
          return json(request, code === "23505" ? 409 : code === "42501" ? 403 : 400,
            { error: code === "23505" ? "claimed" : code === "22023" ? "limit" : "failed" });
        }
      }
      if (!/^[0-9a-f]{64}$/.test(body.verifier ?? "")) return json(request, 400, { error: "Invalid browser verification." });
      let returnUrl: string;
      try { returnUrl = new URL(body.redirectUrl).href; }
      catch { return json(request, 400, { error: "Invalid return address." }); }
      if (!allowed.has(returnUrl) || (origin && new URL(returnUrl).origin !== origin)) {
        return json(request, 400, { error: "This return address is not enabled for Battle.net linking." });
      }
      const state = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      await store.createRequest(await stateHash(state), userId, returnUrl, await stateHash(body.verifier));
      const authorize = new URL(`${BNET_ISSUER}/authorize`);
      authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl,
        response_type: "code", scope: "openid", state }).toString();
      return json(request, 200, { url: authorize.href });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return json(request, code === "42501" ? 403 : code === "54000" ? 429 : 400, {
        error: code === "42501" ? "Please sign in with Discord and open your own profile first."
          : code === "54000" ? "Too many link attempts. Please wait ten minutes."
          : "Could not start Battle.net linking. Please try again.",
      });
    }
  };
}
