import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import axios from "axios";

// Persistent data store for the leaderboard
const DATA_FILE = path.join(process.cwd(), "players_data.json");
let playersData: any[] = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    playersData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) {
    console.error("Error reading players_data.json", e);
  }
}

function savePlayersData(data: any[]) {
  playersData = data;
  fs.writeFileSync(DATA_FILE, JSON.stringify(playersData, null, 2));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Real Discord OAuth implementation
  app.get("/api/auth/discord/url", (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const redirectUri = `${req.protocol}://${req.get("host")}/auth/discord/callback`;
    
    if (!clientId) {
      return res.status(500).json({ error: "DISCORD_CLIENT_ID is not configured in environment variables." });
    }

    const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.json({ url });
  });

  app.get("/auth/discord/callback", async (req, res) => {
    const code = req.query.code as string;
    const redirectUri = `${req.protocol}://${req.get("host")}/auth/discord/callback`;

    if (!code || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      return res.status(400).send("Bad Request: Missing OAuth code or Discord credentials.");
    }

    try {
      const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });

      const tokenResponse = await axios.post("https://discord.com/api/oauth2/token", params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const userResponse = await axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      });

      const user = userResponse.data;

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', user: ${JSON.stringify(user)} }, window.location.origin);
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. Closing window...</p>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error("Discord OAuth Failed", err.response?.data || err.message);
      return res.status(500).send("Discord OAuth Failed. Ensure your ENV vars and Redirect URIs match correctly.");
    }
  });

  // API to retrieve leaderboard data
  app.get("/api/leaderboard", (req, res) => {
    res.json(playersData);
  });

  // Setup Multer for parsing multipart form data
  const upload = multer({ dest: "uploads/" });

  // API to upload and parse CSV
  app.post("/api/admin/upload-csv", upload.single("csv"), (req, res) => {
    const apiKey = req.headers["x-api-key"] || req.query.api_key;
    const expectedKey = process.env.SERVER_API_KEY || "dev-server-key";
    
    if (apiKey !== expectedKey) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(401).json({ success: false, error: "Unauthorized: Invalid Server Key provided." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded." });
    }

    const results: any[] = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => {
        // We delete the temporary uploaded file
        fs.unlinkSync(req.file!.path);

        try {
          // Expected Match Data CSV Headers: match_id, player_name, kills, headshots, won, time_seconds
          const parsedMatches = results.map((row) => ({
            match_id: row.match_id || "unknown",
            player_name: row.player_name || "Unknown",
            kills: parseInt(row.kills) || 0,
            headshots: parseInt(row.headshots) || 0,
            won: row.won === "1" || String(row.won).toLowerCase() === "true" || String(row.won).toLowerCase() === "yes",
            time_seconds: parseInt(row.time_seconds) || 0,
          }));
          
          if (parsedMatches.length === 0) {
            return res.status(400).json({ success: false, error: "Empty CSV or formatting issue" });
          }

          // Aggregate Player Stats
          const playerStats: Record<string, any> = {};
          parsedMatches.forEach(m => {
            if (!playerStats[m.player_name]) {
              playerStats[m.player_name] = { name: m.player_name, matches: 0, wins: 0, kills: 0, headshots: 0 };
            }
            playerStats[m.player_name].matches += 1;
            if (m.won) playerStats[m.player_name].wins += 1;
            playerStats[m.player_name].kills += m.kills;
            playerStats[m.player_name].headshots += m.headshots;
          });

          // Convert to leaderboard format
          const newPlayers = Object.values(playerStats).map(p => {
            const winr = p.matches > 0 ? (p.wins / p.matches) * 100 : 0;
            const hsp = p.kills > 0 ? (p.headshots / p.kills) * 100 : 0;
            // Simple ELO mock calculation: Base + 25 per win, -15 per loss, + 1 per kill
            const losses = p.matches - p.wins;
            const elo = 2000 + (p.wins * 25) - (losses * 15) + p.kills;
            
            return {
              name: p.name,
              tag: elo > 3000 ? "PRO" : "",
              matches: p.matches,
              winrate: winr.toFixed(1) + "%",
              hs: hsp.toFixed(1) + "%",
              elo: elo.toLocaleString("en-US")
            };
          });

          // Sort by ELO descending
          newPlayers.sort((a, b) => {
            const eloA = parseInt(a.elo.replace(/,/g, ""));
            const eloB = parseInt(b.elo.replace(/,/g, ""));
            return eloB - eloA;
          });

          // Assign ranks
          const finalPlayers = newPlayers.map((p, idx) => ({ ...p, rank: idx + 1 }));

          savePlayersData(finalPlayers);
          
          return res.json({ 
            success: true, 
            message: `Processed ${parsedMatches.length} matches. Re-calculated stats for ${finalPlayers.length} players.`, 
            count: finalPlayers.length 
          });
        } catch (err: any) {
          return res.status(500).json({ success: false, error: "Failed to parse mapped columns: " + err.message });
        }
      })
      .on("error", (error) => {
        return res.status(500).json({ success: false, error: error.message });
      });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(\`Server running on http://localhost:\${PORT}\`);
  });
}

startServer();
