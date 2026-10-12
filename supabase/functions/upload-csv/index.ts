import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import Papa from "npm:papaparse@5.4.1";
import { normalizeMatchLog, parseMatchRows, type MatchData } from "./parser.ts";
import { rankPlayers } from "../_shared/leaderboard.ts";
import { readMatchSources, assignMatchId } from "../_shared/match-upload.ts";
import { calculateRating } from "../_shared/rating.ts";
import { createPlayerMap } from "../_shared/player-map.ts";

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

    // 4. Lade alle Spieler für das Name-Mapping (Bnet Account -> Tracker Profil)
    const { data: dbPlayers, error: dbErr } = await supabaseClient.from("players").select("*");
    if (dbErr) throw dbErr;

    const playerMap = createPlayerMap<any>(dbPlayers);

    // 5. Only import players linked to a tracked profile.
    const parsedMatches = matches.filter((m) => playerMap.has(m.player_name.toLowerCase()));

    if (parsedMatches.length === 0) {
      return new Response(JSON.stringify({ error: "Empty CSV/TXT file or no tracked accounts found." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const roundCount = new Set(parsedMatches.map((match) => match.match_id)).size;

    // Verify the duration, match-date and round-count migrations before changing statistics.
    const { error: schemaErr } = await supabaseClient
      .from("player_matches").select("total_match_time, played_at, match_id").limit(0);
    if (schemaErr) throw schemaErr;

    // 6. Match-Aggregation wie vorher
    const playerStats: Record<string, any> = {};

    parsedMatches.forEach((m: any) => {
      const mainPlayer = playerMap.get(m.player_name.toLowerCase());
      if (!mainPlayer) return;
      const mainName = mainPlayer.name;

      if (!playerStats[mainName]) {
        const existingMatches = mainPlayer.matches || 0;
        const existingKdrAvg = parseFloat(mainPlayer.kdr as string) || 0;
        const existingAccAvg = parseFloat(mainPlayer.accuracy as string) || 0;
        const existingKpmAvg = parseFloat(mainPlayer.kpm as string) || 0;

        playerStats[mainName] = {
          name: mainName,
          matches: existingMatches,
          score: mainPlayer.score || 0,
          deaths: mainPlayer.deaths || 0,
          kdr_sum: existingKdrAvg * existingMatches,
          accuracy_sum: existingAccAvg * existingMatches,
          kpm_sum: existingKpmAvg * existingMatches,
          crouches: mainPlayer.crouches || 0,
          time_in_lobby: mainPlayer.time_in_lobby || 0,
          new_matches: [],
        };
      }

      playerStats[mainName].matches += 1;
      playerStats[mainName].score += m.score;
      playerStats[mainName].deaths += m.deaths;
      playerStats[mainName].kdr_sum += m.kdr;
      playerStats[mainName].accuracy_sum += m.accuracy;
      playerStats[mainName].kpm_sum += m.kpm;
      playerStats[mainName].crouches += m.crouches;
      playerStats[mainName].time_in_lobby += m.time_in_lobby;

      const matchPerformanceScore = calculateRating(m);

      playerStats[mainName].new_matches.push({
        player_name: mainName,
        score: m.score,
        deaths: m.deaths,
        accuracy: m.accuracy,
        kpm: m.kpm,
        kdr: m.kdr,
        crouches: m.crouches,
        time_in_lobby: m.time_in_lobby,
        total_match_time: m.total_match_time,
        played_at: m.played_at,
        match_id: m.match_id,
        performance_score: matchPerformanceScore,
      });
    });

    const newPlayers = Object.values(playerStats).map((p) => {
      const avg_kdr = p.matches > 0 ? p.kdr_sum / p.matches : 0;
      const avg_acc = p.matches > 0 ? p.accuracy_sum / p.matches : 0;
      const avg_kpm = p.matches > 0 ? p.kpm_sum / p.matches : 0;

      const finalElo = calculateRating({ kpm: avg_kpm, accuracy: avg_acc, kdr: avg_kdr });

      return {
        name: p.name,
        tag: finalElo >= 1200 ? "PRO" : "",
        matches: p.matches,
        score: p.score,
        deaths: p.deaths,
        kdr: avg_kdr.toFixed(2),
        accuracy: avg_acc.toFixed(2) + "%",
        kpm: avg_kpm.toFixed(2),
        crouches: p.crouches,
        time_in_lobby: p.time_in_lobby,
        elo: finalElo.toLocaleString("en-US"),
        new_matches: p.new_matches,
      };
    });

    // Merge the changed statistics into the entire leaderboard. Ranking only
    // this upload's players would assign another rank 1 on every partial import.
    const updatedNames = new Set(newPlayers.map((p) => p.name));
    const globalRanking = rankPlayers([
      ...dbPlayers.filter((p: any) => !updatedNames.has(p.name)),
      ...newPlayers,
    ]);
    const ranks = new Map(globalRanking.map((p) => [p.name, p.rank]));
    const finalPlayers = newPlayers.map((p) => ({ ...p, rank: ranks.get(p.name)! }));

    // 7. Datenbank Upserts (als Service Role bypassen wir jegliche RLS)
    const playersToUpsert = finalPlayers.map(({ new_matches, ...rest }) => rest);
    const shiftedRanks = dbPlayers.filter((player: any) =>
      !updatedNames.has(player.name) && Number(player.rank) !== (ranks.get(player.name) ?? 999999),
    ).map((player: any) => ({ name: player.name, rank: ranks.get(player.name) ?? 999999 }));

    const historyRows = finalPlayers.map((p) => ({
      player_name: p.name,
      elo: parseInt(p.elo.replace(/,/g, "")),
      rank: p.rank,
    }));

    const matchRows: any[] = [];
    finalPlayers.forEach((p) => {
      if (p.new_matches && p.new_matches.length > 0) {
        matchRows.push(...p.new_matches);
      }
    });

    const { error: importErr } = await supabaseClient.rpc("apply_match_import", {
      p_expected_revision: state.revision,
      p_players: playersToUpsert,
      p_ranks: shiftedRanks,
      p_history: historyRows,
      p_matches: matchRows,
      p_admin_user: apiKey ? "API_AUTOMATION" : "ADMIN_DASHBOARD",
      p_details: `Imported ${roundCount} round(s) with ${parsedMatches.length} tracked player participation(s) from ${fileCount} file(s), updated ${finalPlayers.length} players.`,
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
        message: `Successfully imported ${roundCount} round(s) with ${parsedMatches.length} tracked player participation(s) from ${fileCount} file(s).`,
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
