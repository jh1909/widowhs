import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import Papa from "npm:papaparse@5.4.1";

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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // 3. Extrahiere die Datei
    let csvData = "";
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        throw new Error("No file uploaded or invalid file format");
      }
      csvData = await file.text();
    } else {
      csvData = await req.text();
    }

    // 4. Lade alle Spieler für das Name-Mapping (Bnet Account -> Tracker Profil)
    const { data: dbPlayers, error: dbErr } = await supabaseClient.from("players").select("*");
    if (dbErr) throw dbErr;

    const playerMap = new Map<string, any>();
    dbPlayers.forEach((p: any) => {
      playerMap.set(p.name.toLowerCase(), p);
      if (p.bnet_accounts && Array.isArray(p.bnet_accounts)) {
        p.bnet_accounts.forEach((bnet: string) => {
          playerMap.set(bnet.toLowerCase(), p);
        });
      }
    });

    // 5. CSV Parsen
    const parsedData = Papa.parse(csvData, { header: false, skipEmptyLines: true });

    if (parsedData.errors && parsedData.errors.length > 0) {
      return new Response(JSON.stringify({ error: "CSV Parsing Error", details: parsedData.errors }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsedMatches = parsedData.data
      .map((row: any) => {
        if (!row || !row[0]) return null;
        if (row[0].toString().toLowerCase().includes("player") && isNaN(parseFloat(row[1]))) return null;
        return {
          player_name: row[0].toString().trim(),
          score: parseFloat(row[1]) || 0,
          deaths: parseFloat(row[2]) || 0,
          accuracy: parseFloat(row[3]) || 0,
          kpm: parseFloat(row[4]) || 0,
          kdr: parseFloat(row[5]) || 0,
          crouches: parseFloat(row[6]) || 0,
          time_in_lobby: parseFloat(row[7]) || 0,
        };
      })
      .filter((m: any) => {
        if (!m || m.player_name === "Unknown" || isNaN(m.score)) return false;
        return playerMap.has(m.player_name.toLowerCase());
      });

    if (parsedMatches.length === 0) {
      return new Response(JSON.stringify({ error: "Empty CSV, formatting issue, or no tracked accounts found." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

      const paceScore = Math.min(m.kpm / 16.67, 1.67);
      const accuracyScore = Math.min(m.accuracy / 60, 1.15);
      const kdrScore = Math.min(m.kdr / 3.0, 1.50);
      const matchPerformanceScore = 1000 * (0.55 * paceScore + 0.30 * accuracyScore + 0.15 * kdrScore);

      playerStats[mainName].new_matches.push({
        player_name: mainName,
        score: m.score,
        deaths: m.deaths,
        accuracy: m.accuracy,
        kpm: m.kpm,
        kdr: m.kdr,
        crouches: m.crouches,
        time_in_lobby: m.time_in_lobby,
        performance_score: matchPerformanceScore,
      });
    });

    const newPlayers = Object.values(playerStats).map((p) => {
      const avg_kdr = p.matches > 0 ? p.kdr_sum / p.matches : 0;
      const avg_acc = p.matches > 0 ? p.accuracy_sum / p.matches : 0;
      const avg_kpm = p.matches > 0 ? p.kpm_sum / p.matches : 0;

      const paceScore = Math.min(avg_kpm / 16.67, 1.67);
      const accuracyScore = Math.min(avg_acc / 60, 1.15);
      const kdrScore = Math.min(avg_kdr / 3.0, 1.50);

      const performanceScore = 1000 * (0.55 * paceScore + 0.30 * accuracyScore + 0.15 * kdrScore);
      const finalElo = Math.round(performanceScore);

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

    newPlayers.sort((a, b) => {
      const eloA = parseInt(a.elo.replace(/,/g, ""));
      const eloB = parseInt(b.elo.replace(/,/g, ""));
      return eloB - eloA;
    });

    const finalPlayers = newPlayers.map((p, idx) => ({ ...p, rank: idx + 1 }));

    // 7. Datenbank Upserts (als Service Role bypassen wir jegliche RLS)
    const playersToUpsert = finalPlayers.map(({ new_matches, ...rest }) => rest);
    const { error: upsertErr } = await supabaseClient.from("players").upsert(playersToUpsert, { onConflict: "name" });
    if (upsertErr) throw upsertErr;

    const historyRows = finalPlayers.map((p) => ({
      player_name: p.name,
      elo: parseInt(p.elo.replace(/,/g, "")),
      rank: p.rank,
    }));
    await supabaseClient.from("player_history").insert(historyRows);

    const matchRows: any[] = [];
    finalPlayers.forEach((p) => {
      if (p.new_matches && p.new_matches.length > 0) {
        matchRows.push(...p.new_matches);
      }
    });

    if (matchRows.length > 0) {
      await supabaseClient.from("player_matches").insert(matchRows);
    }

    await supabaseClient.from("audit_logs").insert([
      {
        action: "EDGE_FUNCTION_CSV_UPLOAD",
        admin_user: apiKey ? "API_AUTOMATION" : "ADMIN_DASHBOARD",
        details: \`Imported \${parsedMatches.length} valid matches, updated \${finalPlayers.length} tracked players.\`,
      },
    ]);

    return new Response(
      JSON.stringify({
        success: true,
        message: \`Successfully imported \${parsedMatches.length} valid matches and updated \${finalPlayers.length} players.\`,
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
