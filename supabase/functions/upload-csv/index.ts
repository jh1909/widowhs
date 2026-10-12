import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import Papa from "npm:papaparse@5.4.1";
import { normalizeMatchLog, parseMatchRows, type MatchData } from "./parser.ts";
import { buildMatchImport, type ImportPlayer } from "../_shared/import-stats.ts";
import { readMatchSources, assignMatchId } from "../_shared/match-upload.ts";



const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

serve(async (req) => {
  // Handle CORS Preflight Required For Edge Functions
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authentifizierung: Erlaubt Aufrufe via x-api-key (Python) ODER Supabase User Auth (Frontend)
    const apiKey = req.headers.get("x-api-key");
    const validApiKey = Deno.env.get("ADMIN_API_KEY");
    const authHeader = req.headers.get("Authorization");

    // Falls ein expliziter Key gesetzt ist, aber nicht übereinstimmt, und auch kein User eingeloggt ist:
    if (validApiKey && apiKey !== validApiKey) {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 2. Initialisiere den Supabase Client mit der Service Role (umgangen RLS für volle Datenbankkontrolle in der Funktion)
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    if (!validApiKey || apiKey !== validApiKey) {
      const token = authHeader?.replace(/^Bearer\s+/i, "");
      const { data: auth, error: authError } = token
        ? await supabaseClient.auth.getUser(token) : { data: { user: null }, error: null };
      if (authError || !auth.user) {
        return new Response(JSON.stringify({ error: "Please sign in as an administrator." }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: admins, error: adminError } = await supabaseClient.from("players")
        .select("name").eq("user_id", auth.user.id).eq("is_admin", true).limit(1);
      if (adminError) throw adminError;
      if (!admins?.length) {
        return new Response(JSON.stringify({ error: "Only administrators may import matches." }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Parse each file separately (including its own header), then import the
    // combined matches once so overlapping players accumulate every file.
    const matches: (MatchData & { played_at: string | null; match_id: string })[] = [];
    let fileCount = 0;
    try {
      const sources = await readMatchSources(req);
      fileCount = sources.length;
      for (const source of sources) {
        try {
          const parsedData = Papa.parse<string[]>(normalizeMatchLog(source.text), {
            delimiter: ",", header: false, skipEmptyLines: "greedy",
          });
          if (parsedData.errors.length > 0) {
            throw new Error(parsedData.errors.map((error: { message: string }) => error.message).join("; "));
          }
          const parsedMatches = parseMatchRows(parsedData.data);
          if (!parsedMatches.length) throw new Error("No match records found.");
          matches.push(...assignMatchId(parsedMatches.map((match) => ({ ...match, played_at: source.played_at }))));
        } catch (error) {
          throw new Error(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: `CSV/TXT parsing error: ${message}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Capture the revision before reading players. A reset or another import
    // invalidates this snapshot; the transactional write will reject it.
    const { data: state, error: stateErr } = await supabaseClient
      .from("leaderboard_state").select("revision").eq("singleton", true).single();
    if (stateErr) throw stateErr;

    // Read every profile, beyond PostgREST's default page size.
    const dbPlayers: ImportPlayer[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabaseClient.from("players").select("*")
        .order("name").range(offset, offset + 999);
      if (error) throw error;
      dbPlayers.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const { error: schemaErr } = await supabaseClient.from("player_matches")
      .select("total_match_time, played_at, match_id, logged_player_name").limit(0);
    if (schemaErr) throw schemaErr;
    const imported = buildMatchImport(dbPlayers, matches);
    const { error: importErr } = await supabaseClient.rpc("apply_match_import", {
      p_expected_revision: state.revision,
      p_players: imported.players,
      p_ranks: imported.ranks,
      p_history: imported.history,
      p_matches: imported.matches,
      p_admin_user: apiKey ? "API_AUTOMATION" : "ADMIN_DASHBOARD",
      p_details: `Imported ${imported.roundCount} round(s) with ${matches.length} player participation(s) from ${fileCount} file(s), updated ${imported.players.length} players.`,
    });
    if (importErr) {
      if (importErr.code === "40001") {
        return new Response(JSON.stringify({ error: importErr.message }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw importErr;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully imported ${imported.roundCount} round(s) with ${matches.length} player participation(s) from ${fileCount} file(s).`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
