import { useState, useRef, useEffect } from "react";
import { Link, Route, Routes, useLocation, Navigate } from "react-router-dom";
import Papa from "papaparse";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/AuthContext";
import { 
  LayoutGrid, 
  BarChart2, 
  ShieldAlert, 
  Monitor, 
  FileText,
  Power,
  Search,
  Bell,
  Menu,
  Users,
  TrendingUp,
  Gavel,
  Cpu,
  ArrowRight,
  Edit2,
  Ban,
  Trash2,
  Globe,
  UploadCloud,
  CheckCircle,
  XCircle,
  Loader2
} from "lucide-react";
import { cn } from "../lib/utils";

export default function Admin() {
  const { user } = useAuth();
  
  // Either manually mark usernames here, or rely on the is_admin flag from the database
  const adminUsers = ['notprx'];
  const isAdmin = user && (user.isAdmin || (user.username && adminUsers.includes(user.username.toLowerCase())));

  if (!isAdmin) {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-background text-center p-6 text-white font-sans">
        <ShieldAlert className="w-16 h-16 text-toxic-purple mb-4" />
        <h1 className="text-3xl font-black italic tracking-tighter mb-2">ACCESS DENIED</h1>
        <p className="text-zinc-500 mb-6 max-w-md">You do not have the required administrative privileges to view this module.</p>
        <Link to="/" className="bg-toxic-purple hover:bg-[#842bd2] text-white font-bold py-2 px-6 rounded-md transition-colors flex items-center gap-2">
          <ArrowRight className="w-5 h-5" />
          <span>Return to Leaderboard</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar />
      <div className="flex-1 flex flex-col h-screen overflow-hidden relative">
        <AdminHeader />
        <div className="flex-1 overflow-y-auto w-full">
          <Routes>
            <Route path="/" element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="csv-upload" element={<CsvUpload />} />
            <Route path="server" element={<ServerStatus />} />
            <Route path="audit" element={<AuditLogs />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function CsvUpload() {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus("idle");
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setStatus("idle");
    setMessage("");

    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          // If the CSV has headers, the first row might be ['Player', 'score (kills)', ...]
          const parsedMatches = results.data.map((row: any) => {
            // Check if it's the header row or empty
            if (!row || !row[0]) return null;
            if (row[0].toString().toLowerCase().includes('player') && isNaN(parseFloat(row[1]))) {
               return null;
            }
            return {
              player_name: row[0].toString().trim(),
              score: parseFloat(row[1]) || 0,
              deaths: parseFloat(row[2]) || 0,
              kdr: parseFloat(row[3]) || 0,
              accuracy: parseFloat(row[4]) || 0,
              kpm: parseFloat(row[5]) || 0,
              crouches: parseFloat(row[6]) || 0,
              time_in_lobby: parseFloat(row[7]) || 0,
            };
          }).filter((m: any) => m && m.player_name !== "Unknown" && !isNaN(m.score));
          
          if (parsedMatches.length === 0) {
            setStatus("error");
            setMessage("Empty CSV or formatting issue. Check headers.");
            setUploading(false);
            return;
          }

          // Aggregate Player Stats
          const playerStats: Record<string, any> = {};
          parsedMatches.forEach(m => {
            if (!playerStats[m.player_name]) {
              playerStats[m.player_name] = { 
                name: m.player_name, 
                matches: 0, 
                score: 0, 
                deaths: 0, 
                kdr_sum: 0, 
                accuracy_sum: 0, 
                kpm_sum: 0, 
                crouches: 0, 
                time_in_lobby: 0 
              };
            }
            playerStats[m.player_name].matches += 1;
            playerStats[m.player_name].score += m.score;
            playerStats[m.player_name].deaths += m.deaths;
            playerStats[m.player_name].kdr_sum += m.kdr;
            playerStats[m.player_name].accuracy_sum += m.accuracy;
            playerStats[m.player_name].kpm_sum += m.kpm;
            playerStats[m.player_name].crouches += m.crouches;
            playerStats[m.player_name].time_in_lobby += m.time_in_lobby;
          });

          // Convert to leaderboard format
          const newPlayers = Object.values(playerStats).map(p => {
            const avg_kdr = p.matches > 0 ? (p.kdr_sum / p.matches) : 0;
            const avg_acc = p.matches > 0 ? (p.accuracy_sum / p.matches) : 0;
            const avg_kpm = p.matches > 0 ? (p.kpm_sum / p.matches) : 0;
            
            // Simple generic ELO based on Kills and Deaths
            const elo = 2000 + (p.score * 5) - (p.deaths * 2);
            
            return {
              name: p.name,
              tag: elo > 3000 ? "PRO" : "",
              matches: p.matches,
              score: p.score,
              deaths: p.deaths,
              kdr: avg_kdr.toFixed(2),
              accuracy: avg_acc.toFixed(2) + "%",
              kpm: avg_kpm.toFixed(2),
              crouches: p.crouches,
              time_in_lobby: p.time_in_lobby,
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

          // Upsert to Supabase
          const { error } = await supabase
            .from("players")
            .upsert(finalPlayers, { onConflict: "name" });

          if (error) throw error;

          // Track historical data
          const historyRows = finalPlayers.map(p => ({
            player_name: p.name,
            elo: parseInt(p.elo.replace(/,/g, "")),
            rank: p.rank
          }));
          
          const { error: historyError } = await supabase.from("player_history").insert(historyRows);
          if (historyError) {
             console.warn("Could not insert player_history records. Make sure the player_history table exists.", historyError);
          }

          await supabase.from("audit_logs").insert([{
            action: "CSV_UPLOAD",
            admin_user: user?.username || "UnknownAdmin",
            details: `Imported ${parsedMatches.length} matches, updated ${finalPlayers.length} players.`
          }]);

          setStatus("success");
          setMessage(`Successfully processed ${parsedMatches.length} matches and updated ${finalPlayers.length} players. Ensure 'players' table exists in Supabase.`);
          setFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        } catch (error: any) {
          console.error(error);
          setStatus("error");
          setMessage(error.message || "An unexpected error occurred during database upsert.");
        } finally {
          setUploading(false);
        }
      },
      error: (error) => {
        setStatus("error");
        setMessage(`CSV Parsing Error: ${error.message}`);
        setUploading(false);
      }
    });
  };

  return (
    <div className="p-6 lg:p-10 space-y-8 h-full max-w-5xl mx-auto">
      <div>
        <h2 className="font-sans text-2xl font-bold text-white tracking-tight">CSV Data Sync</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Manage core system data, imports, and global settings.</p>
      </div>

      <div className="bg-[#111114] border border-surface-container-highest rounded-md overflow-hidden p-6 max-w-2xl">
        <h3 className="font-sans text-[18px] font-bold text-white mb-2">Import Match Data</h3>
        <p className="font-sans text-[13px] text-zinc-400 mb-6">
          Upload a CSV file to overwrite the global player statistics and recalculate leaderboards. Ensure your CSV has columns like: <code className="bg-white/10 px-1 py-0.5 rounded text-toxic-purple mx-1">Player, score (kills), deaths, kdr, accuracy, kills/min, crouches, time in lobby</code>
        </p>

        <div 
          className={cn(
            "border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center transition-colors",
            file ? "border-toxic-purple/50 bg-toxic-purple/5" : "border-surface-container hover:border-toxic-purple/30 hover:bg-surface-container-low cursor-pointer"
          )}
          onClick={() => !file && fileInputRef.current?.click()}
        >
          <input 
            type="file" 
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".csv"
            className="hidden" 
          />
          
          <UploadCloud className={cn("w-10 h-10 mb-4", file ? "text-toxic-purple" : "text-zinc-500")} />
          
          {file ? (
            <div className="text-center font-sans">
              <p className="text-white font-bold">{file.name}</p>
              <p className="text-zinc-500 text-xs mt-1">{(file.size / 1024).toFixed(2)} KB</p>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                  setStatus("idle");
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="text-xs text-red-400 hover:text-red-300 mt-3 underline"
              >
                Remove selection
              </button>
            </div>
          ) : (
            <div className="text-center font-sans">
              <p className="text-zinc-300 font-bold">Click or drag CSV file to upload</p>
              <p className="text-zinc-600 text-xs mt-2">Maximum file size: 5MB</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {status === "success" && (
              <>
                <CheckCircle className="w-5 h-5 text-green-500 min-w-5 shrink-0" />
                <span className="text-sm text-green-400">{message}</span>
              </>
            )}
            {status === "error" && (
              <>
                <XCircle className="w-5 h-5 text-red-500 min-w-5 shrink-0" />
                <span className="text-sm text-red-400 max-w-sm truncate whitespace-normal leading-tight">{message}</span>
              </>
            )}
          </div>
          <button 
            disabled={!file || uploading}
            onClick={handleUpload}
            className="bg-toxic-purple hover:bg-[#842bd2] text-white font-bold py-2 px-6 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shrink-0"
          >
            {uploading && <Loader2 className="w-4 h-4 animate-spin" />}
            {uploading ? "Processing..." : "Import Data"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerStatus() {
  const [latency, setLatency] = useState(0);
  const [dbStats, setDbStats] = useState({ players: 0, banned: 0, logs: 0 });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [
          { count: players }, 
          { count: banned },
          { count: logs }
        ] = await Promise.all([
          supabase.from('players').select('*', { count: 'exact', head: true }),
          supabase.from('players').select('*', { count: 'exact', head: true }).eq('is_banned', true),
          supabase.from('audit_logs').select('*', { count: 'exact', head: true })
        ]);
        
        setDbStats({
          players: players || 0,
          banned: banned || 0,
          logs: logs || 0
        });
      } catch (err) {
         console.error(err);
      }
    };
    fetchStats();

    // mock latency check
    const checkLatency = async () => {
      const start = Date.now();
      await supabase.from('players').select('name').limit(1);
      setLatency(Date.now() - start);
    };
    checkLatency();
    const interval = setInterval(checkLatency, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-6 lg:p-10 space-y-8 h-full max-w-5xl mx-auto">
      <div>
        <h2 className="font-sans text-2xl font-bold text-white tracking-tight">Server Status</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Real-time database connectivity and health.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-[#111114] border border-surface-container-highest rounded-md p-6">
          <h3 className="font-sans text-sm font-bold text-zinc-400 mb-4 uppercase tracking-widest">Database Node</h3>
          <div className="flex items-center space-x-4 mb-4">
            <div className={`w-3 h-3 rounded-full ${latency < 200 ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'bg-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.5)]'}`}></div>
            <span className="text-white font-mono">{latency < 200 ? 'Healthy' : 'Degraded'}</span>
          </div>
          <div className="space-y-2 font-mono text-[13px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">Latency</span>
              <span className="text-zinc-300">{latency}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Total Players in DB</span>
              <span className="text-zinc-300">{dbStats.players}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Banned Accounts</span>
              <span className="text-zinc-300">{dbStats.banned}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Audit Events</span>
              <span className="text-zinc-300">{dbStats.logs}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Provider</span>
              <span className="text-zinc-300">Supabase</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Region</span>
              <span className="text-zinc-300">eu-central-1</span>
            </div>
             <div className="flex justify-between">
              <span className="text-zinc-500">Uptime</span>
              <span className="text-zinc-300">99.99%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuditLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchLogs() {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (data) setLogs(data);
      setLoading(false);
    }
    fetchLogs();
  }, []);

  const formatTime = (isoString: string) => {
    if (!isoString) return '';
    return new Date(isoString).toLocaleString(undefined, { 
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="p-6 lg:p-10 space-y-8 h-full max-w-5xl mx-auto">
      <div>
        <h2 className="font-sans text-2xl font-bold text-white tracking-tight">Audit Logs</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Immutable record of administrative actions.</p>
      </div>

      <div className="bg-[#111114] border border-surface-container-highest rounded-md overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 text-toxic-purple animate-spin" /></div>
        ) : logs.length > 0 ? (
          <ul className="divide-y divide-surface-container-highest/50">
            {logs.map(log => (
              <li key={log.id} className="p-4 hover:bg-surface-container-low transition-colors flex items-start gap-4">
                <div className="p-2 bg-surface-container rounded border border-surface-container-highest/50 text-zinc-500 mt-1">
                  <FileText className="w-4 h-4" />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between">
                    <span className="font-sans font-bold text-sm text-white">{log.action || "UNKNOWN_ACTION"}</span>
                    <span className="font-mono text-xs text-zinc-500">{formatTime(log.created_at)}</span>
                  </div>
                  <p className="font-mono text-[13px] text-zinc-400 mt-1">{log.details}</p>
                  <div className="font-mono text-[11px] text-zinc-600 mt-2 uppercase">User: {log.admin_user}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-8 text-center text-zinc-500 font-mono text-[13px]">No audit logs found. Ensure 'audit_logs' table exists.</div>
        )}
      </div>
    </div>
  );
}

function AdminHeader() {
  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-surface-container-highest z-30 bg-surface-dim/80 backdrop-blur-xl shrink-0">
      <div className="flex items-center">
        <button className="md:hidden text-zinc-400 hover:text-white mr-4">
          <Menu className="w-6 h-6" />
        </button>
        <Link to="/" className="md:hidden text-lg font-black text-white italic tracking-tighter border-l-4 border-toxic-purple pl-2">
          WIDOW HS
        </Link>
      </div>

      <div className="flex-1 max-w-md ml-4 md:ml-0 hidden md:block">
        <div className="relative flex items-center w-full toxic-glow-focus rounded transition-all duration-200 bg-surface-container border border-surface-container-highest">
          <Search className="absolute left-3 text-zinc-500 w-[18px] h-[18px]" />
          <input
            className="w-full bg-transparent border-none text-zinc-200 font-mono text-[13px] placeholder:text-zinc-600 py-2 pl-10 pr-4 focus:ring-0 focus:outline-none"
            placeholder="SEARCH UIDs OR USERNAMES..."
            type="text"
          />
        </div>
      </div>

      <div className="flex items-center space-x-4 ml-4">
        <button className="text-zinc-500 hover:text-purple-400 transition-colors relative">
          <Bell className="w-5 h-5" />
          <span className="absolute top-0 right-0 w-2 h-2 bg-toxic-purple rounded-full"></span>
        </button>
        <div className="h-8 w-8 rounded bg-surface-container-highest flex items-center justify-center border border-toxic-purple/20 text-purple-400 font-sans font-bold text-[11px] uppercase tracking-widest cursor-pointer">
          AD
        </div>
      </div>
    </header>
  );
}

function AdminSidebar() {
  const location = useLocation();
  const currentPath = location.pathname;

  return (
    <nav className="bg-[#111114] w-64 border-r border-toxic-purple/10 shadow-[-10px_0_20px_0_rgba(168,85,247,0.05)_inset] flex-col py-8 fixed md:relative h-full z-40 hidden md:flex shrink-0">
      <div className="px-6 mb-10">
        <Link to="/" className="block">
          <h1 className="font-sans text-[22px] text-toxic-purple font-black tracking-tighter italic border-l-4 border-toxic-purple pl-2 leading-none hover:text-[#D8B4FE] transition-colors">
            SYSTEM<br />ROOT
          </h1>
        </Link>
        <p className="font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest mt-4">ADMINISTRATOR</p>
      </div>
      
      <ul className="flex-1 px-4 space-y-2">
        <SidebarItem icon={<LayoutGrid />} label="Dashboard" to="/admin/dashboard" active={currentPath.includes("dashboard")} />
        <SidebarItem icon={<UploadCloud />} label="CSV Data Sync" to="/admin/csv-upload" active={currentPath.includes("csv-upload")} />
        <SidebarItem icon={<Monitor />} label="Server Status" to="/admin/server" active={currentPath.includes("server")} />
        <SidebarItem icon={<FileText />} label="Audit Logs" to="/admin/audit" active={currentPath.includes("audit")} />
      </ul>
      
      <div className="px-6 mt-auto flex flex-col gap-2">
        <Link to="/" className="w-full bg-toxic-purple/10 text-toxic-purple font-sans font-bold text-[11px] uppercase tracking-widest py-3 px-4 rounded flex items-center justify-center space-x-2 border border-toxic-purple/20 hover:bg-toxic-purple/20 hover:border-toxic-purple/30 transition-all cursor-pointer">
          <Globe className="w-4 h-4" />
          <span>MAIN SITE</span>
        </Link>
        <button className="w-full bg-transparent border border-surface-container-highest text-zinc-500 font-sans font-bold text-[11px] uppercase tracking-widest py-3 px-4 rounded flex items-center justify-center space-x-2 hover:bg-surface-container-highest hover:text-white transition-colors cursor-pointer">
          <Power className="w-4 h-4" />
          <span>LOGOUT</span>
        </button>
      </div>
    </nav>
  );
}

function SidebarItem({ icon, label, to, active }: { icon: React.ReactNode, label: string, to: string, active: boolean }) {
  return (
    <li>
      <Link
        to={to}
        className={cn(
          "flex items-center space-x-3 px-4 py-3 rounded font-sans font-bold text-[11px] uppercase tracking-widest transition-all duration-200 ease-in-out group",
          active 
            ? "bg-toxic-purple/10 text-purple-400 border-r-2 border-toxic-purple" 
            : "text-zinc-600 hover:bg-toxic-purple/5 hover:text-purple-300 hover:translate-x-1"
        )}
      >
        <span className="w-[18px] h-[18px]">{icon}</span>
        <span>{label}</span>
      </Link>
    </li>
  );
}

function Dashboard() {
  const { user } = useAuth();
  const [totalPlayers, setTotalPlayers] = useState<number | null>(null);
  const [bannedPlayers, setBannedPlayers] = useState<number>(0);

  const [players, setPlayers] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const PAGE_SIZE = 10;

  const logAudit = async (action: string, details: string) => {
    await supabase.from("audit_logs").insert([{
      action,
      admin_user: user?.username || "UnknownAdmin",
      details
    }]);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const loadPlayers = async () => {
    try {
      let query = supabase.from('players').select('*', { count: 'exact' });
      if (debouncedSearch) {
        query = query.ilike('name', `%${debouncedSearch}%`);
      }
      
      const from = (currentPage - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      query = query.order('rank', { ascending: true }).range(from, to);
      
      const { data, count, error } = await query;
      if (!error) {
        setPlayers(data || []);
        if (count !== null) setTotalFiltered(count);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadPlayers();
  }, [debouncedSearch, currentPage]);

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        const [{ count: playersCount }, { count: bannedCount }] = await Promise.all([
          supabase.from('players').select('*', { count: 'exact', head: true }),
          supabase.from('players').select('*', { count: 'exact', head: true }).eq('is_banned', true)
        ]);
        
        setTotalPlayers(playersCount || 0);
        setBannedPlayers(bannedCount || 0);
      } catch (err) {
        console.error("Error fetching dashboard data:", err);
      }
    }
    fetchDashboardData();
  }, []);

  const handleDelete = async (playerName: string) => {
    if (window.confirm(`Are you sure you want to completely delete player '${playerName}'?`)) {
      const { error } = await supabase.from('players').delete().eq('name', playerName);
      if (!error) {
        if (totalPlayers) setTotalPlayers(prev => prev! - 1);
        logAudit("DELETE_PLAYER", `Deleted player ${playerName} from the database.`);
        loadPlayers();
      } else {
        alert("Failed to delete user: " + error.message);
      }
    }
  };

  const handleBan = async (player: any) => {
    const isCurrentlyBanned = player.is_banned;
    const newStatus = !isCurrentlyBanned;
    const actionLabel = newStatus ? "Ban" : "Unban";
    
    if (window.confirm(`Are you sure you want to ${actionLabel} player '${player.name}'?`)) {
      const { error } = await supabase.from('players').update({ is_banned: newStatus }).eq('name', player.name);
      if (!error) {
        setBannedPlayers(prev => newStatus ? prev + 1 : prev - 1);
        logAudit(`${newStatus ? 'BAN' : 'UNBAN'}_PLAYER`, `${newStatus ? 'Banned' : 'Unbanned'} player ${player.name}.`);
        loadPlayers();
      } else {
        alert(`Failed to ${actionLabel} user: ` + error.message);
      }
    }
  };

  const [editingPlayer, setEditingPlayer] = useState<any>(null);
  const [editForm, setEditForm] = useState({ name: '', is_admin: false });

  const handleEdit = (player: any) => {
    setEditingPlayer(player);
    setEditForm({ name: player.name, is_admin: !!player.is_admin });
  };

  const submitEdit = async () => {
    if (!editingPlayer) return;
    
    if (editForm.name.trim() === '') {
      alert("Name cannot be empty.");
      return;
    }

    const { error } = await supabase
      .from('players')
      .update({ name: editForm.name, is_admin: editForm.is_admin })
      .eq('name', editingPlayer.name);

    if (!error) {
      logAudit("EDIT_PLAYER", `Updated player ${editingPlayer.name}. New name: ${editForm.name}, Role: ${editForm.is_admin ? 'Admin' : 'Player'}.`);
      setEditingPlayer(null);
      loadPlayers();
    } else {
      alert("Failed to edit user: " + error.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));

  return (
    <div className="p-6 lg:p-10 space-y-8 h-full">
      <div>
        <h2 className="font-sans text-2xl font-bold text-white">Dashboard Overview</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Real-time telemetry and active administrative alerts.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-[#111114] border border-surface-container-highest rounded-md p-6 toxic-border-top toxic-bloom flex flex-col justify-between">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center space-x-2">
              <Users className="text-toxic-purple w-5 h-5 pointer-events-none" />
              <span className="font-sans font-bold text-[11px] text-zinc-400 uppercase tracking-widest">Total Players</span>
            </div>
            <span className="px-2 py-1 bg-toxic-purple/10 text-toxic-purple font-mono text-[10px] rounded flex items-center space-x-1 border border-toxic-purple/20">
              <TrendingUp className="w-3 h-3" />
              <span>LIVE</span>
            </span>
          </div>
          <div>
            <div className="font-sans text-4xl font-extrabold text-white tracking-tight">{totalPlayers !== null ? totalPlayers.toLocaleString() : "..."}</div>
            <div className="font-mono text-[13px] text-zinc-500 mt-2">Tracked in Database</div>
          </div>
        </div>

        <div className="bg-[#111114] border border-surface-container-highest rounded-md p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center space-x-2">
              <Gavel className="text-red-500 w-5 h-5" />
              <span className="font-sans font-bold text-[11px] text-zinc-400 uppercase tracking-widest">Active Bans</span>
            </div>
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          </div>
          <div>
            <div className="font-sans text-4xl font-extrabold text-white tracking-tight">{bannedPlayers}</div>
            <div className="font-mono text-[13px] text-zinc-500 mt-2">Players restricted from ranking</div>
          </div>
        </div>
      </div>

      <div className="bg-[#111114] border border-surface-container-highest rounded-md flex flex-col">
        <div className="p-6 border-b border-surface-container-highest sm:flex justify-between items-center space-y-4 sm:space-y-0">
          <h3 className="font-sans text-[18px] font-bold text-white">Player Management</h3>
          <div className="relative toxic-glow-focus rounded transition-all duration-200 bg-surface-container border border-surface-container-highest w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 w-[16px] h-[16px]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search players..."
              className="w-full bg-transparent border-none text-zinc-200 font-mono text-[13px] placeholder:text-zinc-600 py-2 pl-9 pr-4 focus:ring-0 focus:outline-none"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-surface-container-low border-b border-surface-container-highest">
                <th className="py-3 px-6 font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest">Username</th>
                <th className="py-3 px-6 font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest">Status</th>
                <th className="py-3 px-6 font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest">Rank</th>
                <th className="py-3 px-6 font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest">Matches</th>
                <th className="py-3 px-6 font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px] text-zinc-300 divide-y divide-surface-container-highest/50">
              {players.length > 0 ? (
                players.map((player) => (
                  <ActivityRow 
                    key={player.name}
                    id={player.name} 
                    initial={player.name[0]?.toUpperCase() || "?"} 
                    status={player.is_banned ? "Banned" : (player.matches && player.matches > 0 ? "Ranked" : "Unranked")} 
                    rank={Number(player.rank) >= 999999 ? "-" : `#${player.rank}`} 
                    matches={player.matches?.toString() || "0"} 
                    type={player.is_banned ? "red" : (player.matches && player.matches > 0 ? "green" : "zinc")} 
                    onEdit={() => handleEdit(player)}
                    onBan={() => handleBan(player)}
                    onDelete={() => handleDelete(player.name)}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-6 px-6 text-center text-zinc-500">No players found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="p-4 border-t border-surface-container-highest flex items-center justify-between text-zinc-500 text-xs font-mono">
          <span>Showing {(currentPage - 1) * PAGE_SIZE + players.length > 0 ? (currentPage - 1) * PAGE_SIZE + 1 : 0} to {(currentPage - 1) * PAGE_SIZE + players.length} of {totalFiltered} players</span>
          <div className="flex items-center space-x-2">
            <button 
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1 bg-surface-container border border-surface-container-highest rounded hover:bg-surface-container-highest hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <span className="px-2 text-zinc-400">Page {currentPage} of {totalPages}</span>
            <button 
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages || totalFiltered === 0}
              className="px-3 py-1 bg-surface-container border border-surface-container-highest rounded hover:bg-surface-container-highest hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
      
      {editingPlayer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#111114] border border-surface-container-highest rounded-md p-6 max-w-sm w-full mx-auto shadow-2xl relative">
            <h3 className="font-sans text-xl font-bold text-white mb-6 tracking-tight">Edit Player</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block font-sans font-bold text-[11px] text-zinc-500 uppercase tracking-widest mb-2">Username</label>
                <input 
                  type="text" 
                  value={editForm.name} 
                  onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full bg-surface-container border border-surface-container-highest rounded px-3 py-2 text-white font-mono text-[13px] focus:border-toxic-purple focus:outline-none transition-colors"
                />
              </div>
              
              <div className="flex items-center space-x-3 pt-2">
                <input 
                  type="checkbox" 
                  id="isAdminCheckbox"
                  checked={editForm.is_admin}
                  onChange={e => setEditForm({ ...editForm, is_admin: e.target.checked })}
                  className="w-4 h-4 rounded border-surface-container-highest bg-surface-container text-toxic-purple focus:ring-toxic-purple/30 bg-transparent accent-toxic-purple"
                />
                <label htmlFor="isAdminCheckbox" className="font-sans font-bold text-[13px] text-zinc-300 select-none">
                  Administrator Privileges
                </label>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-end space-x-3">
              <button 
                onClick={() => setEditingPlayer(null)}
                className="px-4 py-2 text-xs font-bold font-sans text-zinc-400 hover:text-white uppercase tracking-widest transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={submitEdit}
                className="px-4 py-2 text-xs font-bold font-sans bg-toxic-purple/10 text-toxic-purple hover:bg-toxic-purple hover:text-black uppercase tracking-widest rounded border border-toxic-purple/30 transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="h-8"></div>
    </div>
  );
}

function ActivityRow({ id, initial, status, rank, matches, type, onEdit, onBan, onDelete }: any) {
  return (
    <tr className="hover:bg-toxic-purple/5 transition-colors group">
      <td className="py-3 px-6 flex items-center space-x-2">
        <div className="w-6 h-6 rounded bg-surface-container flex items-center justify-center text-[10px] font-sans font-bold text-zinc-500 border border-zinc-800">
          {initial}
        </div>
        <span className="text-white">{id}</span>
      </td>
      <td className="py-3 px-6">
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase font-sans font-bold border",
          type === 'green' && "bg-green-500/10 text-green-400 border-green-500/20",
          type === 'zinc' && "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
          type === 'red' && "bg-red-500/10 text-red-400 border-red-500/20"
        )}>
          {status}
        </span>
      </td>
      <td className="py-3 px-6 text-zinc-500">{rank}</td>
      <td className="py-3 px-6 text-zinc-500">{matches}</td>
      <td className="py-3 px-6 text-right">
        <div className="flex items-center justify-end space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onEdit} className="p-1 text-zinc-500 hover:text-white transition-colors cursor-pointer" title="Edit">
            <Edit2 className="w-4 h-4" />
          </button>
          <button onClick={onBan} className="p-1 text-zinc-500 hover:text-red-400 transition-colors cursor-pointer" title="Ban">
            <Ban className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="p-1 text-zinc-500 hover:text-red-600 transition-colors cursor-pointer" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
