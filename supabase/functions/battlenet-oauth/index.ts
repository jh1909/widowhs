import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { createBattleNetOAuthHandler, type OAuthRequest } from "../_shared/battlenet-oauth.ts";

const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
serve(createBattleNetOAuthHandler({
  config: {
    clientId: Deno.env.get("BATTLENET_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("BATTLENET_CLIENT_SECRET") ?? "",
    callbackUrl: Deno.env.get("BATTLENET_CALLBACK_URL") ?? "",
    redirectUrls: (Deno.env.get("BATTLENET_REDIRECT_URLS") ?? "").split(/[\n,]/).map(url => url.trim()).filter(Boolean),
  },
  store: {
    getUser: async token => {
      const { data, error } = await client.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    createRequest: async (hash, userId, redirectUrl, browserHash) => {
      const { error } = await client.rpc("create_battlenet_oauth_request", {
        p_state_hash: hash, p_user_id: userId, p_redirect_url: redirectUrl, p_browser_hash: browserHash,
      });
      if (error) throw error;
    },
    consumeRequest: async hash => {
      const { data, error } = await client.rpc("consume_battlenet_oauth_request", { p_state_hash: hash });
      if (error) throw error;
      return data as OAuthRequest | null;
    },
    saveResult: async (hash, request, identity) => {
      const { error } = await client.rpc("save_battlenet_oauth_result", {
        p_state_hash: hash, p_user_id: request.user_id, p_redirect_url: request.redirect_url,
        p_browser_hash: request.browser_hash, p_account_id: identity.accountId, p_battletag: identity.battleTag,
      });
      if (error) throw error;
    },
    completeResult: async (hash, userId, browserHash) => {
      const { error } = await client.rpc("finish_battlenet_oauth", {
        p_state_hash: hash, p_user_id: userId, p_browser_hash: browserHash,
      });
      if (error) throw error;
    },
  },
}));
