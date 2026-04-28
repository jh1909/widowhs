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
  
  // Replace this array with other admin usernames or connect to your database in the future
  const adminUsers = ['notprx'];
  const isAdmin = user && user.username && adminUsers.includes(user.username.toLowerCase());

  if (!isAdmin) {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-background text-center p-6 text-white font-sans">
        <ShieldAlert className="w-16 h-16 text-toxic-purple mb-4" />
        <h1 className="text-3xl font-black italic tracking-tighter mb-2">ACCESS DENIED</h1>
        <p className="text-zinc-500 mb-6 max-w-md">You do not have the required administrative privileges to view this module. Please login with an authorized discord account (e.g., as notprx).</p>
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
            <Route path="analytics" element={<Placeholder title="Analytics" />} />
            <Route path="panel" element={<AdminPanel />} />
            <Route path="server" element={<Placeholder title="Server Status" />} />
            <Route path="audit" element={<Placeholder title="Audit Logs" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function AdminPanel() {
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
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const parsedMatches = results.data.map((row: any) => ({
            match_id: row.match_id || "unknown",
            player_name: row.player_name || "Unknown",
            kills: parseInt(row.kills) || 0,
            headshots: parseInt(row.headshots) || 0,
            won: row.won === "1" || String(row.won).toLowerCase() === "true" || String(row.won).toLowerCase() === "yes",
            time_seconds: parseInt(row.time_seconds) || 0,
          }));
          
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

          // Upsert to Supabase
          const { error } = await supabase
            .from("players")
            .upsert(finalPlayers, { onConflict: "name" });

          if (error) throw error;

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
        <h2 className="font-sans text-2xl font-bold text-white tracking-tight">Admin Panel</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Manage core system data, imports, and global settings.</p>
      </div>

      <div className="bg-[#111114] border border-surface-container-highest rounded-md overflow-hidden p-6 max-w-2xl">
        <h3 className="font-sans text-[18px] font-bold text-white mb-2">Import Match Data</h3>
        <p className="font-sans text-[13px] text-zinc-400 mb-6">
          Upload a CSV file to overwrite the global player statistics and recalculate leaderboards. Ensure your CSV has headers exactly matching: <code className="bg-white/10 px-1 py-0.5 rounded text-toxic-purple mx-1">match_id,player_name,kills,headshots,won,time_seconds</code>
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

function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6 lg:p-10 h-full flex items-center justify-center">
      <div className="text-center">
        <h2 className="font-sans text-2xl font-bold text-white mb-2">{title}</h2>
        <p className="text-zinc-500 font-sans text-sm">This module is currently active and collecting telemetry data.</p>
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
        <SidebarItem icon={<BarChart2 />} label="Analytics" to="/admin/analytics" active={currentPath.includes("analytics")} />
        <SidebarItem icon={<ShieldAlert />} label="Admin Panel" to="/admin/panel" active={currentPath.includes("panel")} />
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
  const [totalPlayers, setTotalPlayers] = useState<number | null>(null);
  const [recentPlayers, setRecentPlayers] = useState<any[]>([]);

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        // Fetch total count using exact count head-only request if possible,
        // or just fetch all and get length.
        const { count, error } = await supabase
          .from('players')
          .select('*', { count: 'exact', head: true });
          
        if (!error && count !== null) {
          setTotalPlayers(count);
        } else {
          // Fallback
          const { data } = await supabase.from('players').select('name').limit(1000);
          if (data) setTotalPlayers(data.length);
        }

        // Fetch some recent/top players for activity mock
        const { data: topPlayers } = await supabase
          .from('players')
          .select('*')
          .order('rank', { ascending: true })
          .limit(3);
          
        if (topPlayers) {
          setRecentPlayers(topPlayers);
        }
      } catch (err) {
        console.error("Error fetching dashboard data:", err);
      }
    }
    fetchDashboardData();
  }, []);

  return (
    <div className="p-6 lg:p-10 space-y-8 h-full">
      <div>
        <h2 className="font-sans text-2xl font-bold text-white">Dashboard Overview</h2>
        <p className="font-sans text-xs text-zinc-500 mt-1">Real-time telemetry and active administrative alerts.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
            <div className="font-sans text-4xl font-extrabold text-white tracking-tight">0</div>
            <div className="font-mono text-[13px] text-zinc-500 mt-2">Appeals Pending: 0</div>
          </div>
        </div>

        <div className="bg-[#111114] border border-surface-container-highest rounded-md p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center space-x-2">
              <Cpu className="text-blue-500 w-5 h-5" />
              <span className="font-sans font-bold text-[11px] text-zinc-400 uppercase tracking-widest">System Load</span>
            </div>
            <span className="font-mono text-[10px] text-blue-400 uppercase">US-EAST</span>
          </div>
          <div>
            <div className="font-sans text-4xl font-extrabold text-white tracking-tight">12%</div>
            <div className="mt-3 w-full bg-surface-container-highest rounded-full h-[4px] relative">
              <div className="absolute top-0 left-0 h-full bg-blue-500 rounded-full w-[12%] shadow-[0_0_10px_rgba(59,130,246,0.5)]"></div>
            </div>
            <div className="font-mono text-[13px] text-zinc-500 mt-2 flex justify-between">
              <span>Ping: 24ms</span>
              <span>Status: Optimal</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[#111114] border border-surface-container-highest rounded-md overflow-hidden">
        <div className="p-6 border-b border-surface-container-highest flex justify-between items-center">
          <h3 className="font-sans text-[18px] font-bold text-white">Recent Top Player Activity</h3>
          <button className="font-sans font-bold text-[11px] text-purple-400 hover:text-purple-300 uppercase tracking-widest flex items-center space-x-1 cursor-pointer">
            <span>View All</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
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
              {recentPlayers.length > 0 ? (
                recentPlayers.map((player) => (
                  <ActivityRow 
                    key={player.name}
                    id={player.name} 
                    initial={player.name[0]?.toUpperCase() || "?"} 
                    status="Ranked" 
                    rank={`#${player.rank}`} 
                    matches={player.matches.toString()} 
                    type="green" 
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-6 px-6 text-center text-zinc-500">No players found. Import data first.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      <div className="h-8"></div>
    </div>
  );
}

function ActivityRow({ id, initial, status, rank, matches, type }: any) {
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
          <button className="p-1 text-zinc-500 hover:text-white transition-colors cursor-pointer" title="Edit">
            <Edit2 className="w-4 h-4" />
          </button>
          <button className="p-1 text-zinc-500 hover:text-red-400 transition-colors cursor-pointer" title="Ban">
            <Ban className="w-4 h-4" />
          </button>
          <button className="p-1 text-zinc-500 hover:text-red-600 transition-colors cursor-pointer" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
