import { ArrowLeft, Target, Flame, Zap, Swords, Trophy, Timer, Verified, AlertTriangle, Edit2, Check, X } from "lucide-react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/AuthContext";

export default function Profile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const playerName = id ? id.toUpperCase() : "UNKNOWN";
  
  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  useEffect(() => {
    async function fetchPlayerData() {
      if (!id) return;
      
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("players")
          .select("*")
          .ilike("name", id)
          .limit(1);

        if (error) {
           throw error;
        }
        
        if (data && data.length > 0) {
          setPlayer(data[0]);
          setError(null);
        } else if (user && user.username.toLowerCase() === id.toLowerCase()) {
          // Fallback for missing user profile if it's the logged-in user
          setPlayer({
              name: user.username,
              tag: "",
              elo: "-",
              rank: "-",
              winrate: "0%",
              hs: "0%",
              matches: 0
          });
          setError(null);
        } else {
          setError("Could not find player data.");
        }
      } catch (err: any) {
        console.error("Failed to load player data", err);
        setError("Could not find player data.");
      } finally {
        setLoading(false);
      }
    }

    fetchPlayerData();
  }, [id, user]);

  const handleUpdateName = async () => {
    if (!editNameValue.trim() || editNameValue.trim() === player.name) {
      setIsEditingName(false);
      return;
    }
    setEditLoading(true);
    try {
      // First check if the new name already exists
      const { data: existing } = await supabase
          .from("players")
          .select("name")
          .ilike("name", editNameValue.trim())
          .single();
          
      if (existing) {
        alert("This name is already taken by another player.");
        setEditLoading(false);
        return;
      }

      // Update the name
      const { error } = await supabase
        .from("players")
        .update({ name: editNameValue.trim() })
        .eq("name", player.name);

      if (error) throw error;
      
      setIsEditingName(false);
      // Navigate to the new URL
      navigate(`/player/${encodeURIComponent(editNameValue.trim())}`);
    } catch (err: any) {
      console.error("Error updating name:", err);
      alert("Failed to update name.");
    } finally {
      setEditLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-12 items-center justify-center">
        <div className="animate-spin text-[#9d4edd] w-8 h-8 rounded-full border-2 border-t-transparent border-current"></div>
        <p className="font-mono text-zinc-500 uppercase tracking-widest text-[12px]">Loading profile data...</p>
      </main>
    );
  }

  if (error || !player) {
    return (
      <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-6 items-center justify-center">
        <AlertTriangle className="text-red-500 w-16 h-16" />
        <h1 className="font-sans text-[24px] font-bold text-on-surface uppercase tracking-tighter">Player Not Found</h1>
        <Link to="/" className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px] mt-4">
          <ArrowLeft className="w-[18px] h-[18px]" />
          Return to Leaderboard
        </Link>
      </main>
    );
  }

  // Derive some placeholder stats from actual DB fields to make it look active,
  // since the DB might only have what we parse in the CSV.
  const numericWinrate = player?.winrate && player.winrate !== "-" ? parseFloat(player.winrate.replace('%', '')) : 0;
  const gamesWon = player?.matches && player.matches !== "-" ? Math.floor((Number(player.matches) * numericWinrate) / 100) : 0;

  return (
    <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-12">
      {/* Navigation Back Action */}
      <div className="flex items-center">
        <Link to="/" className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px]">
          <ArrowLeft className="w-[18px] h-[18px]" />
          Back to Leaderboard
        </Link>
      </div>

      {/* Profile Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-[#4d4353]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            {isEditingName ? (
              <div className="flex items-center gap-2">
                <input 
                  type="text"
                  value={editNameValue}
                  onChange={(e) => setEditNameValue(e.target.value)}
                  className="bg-surface-container/50 border border-toxic-purple/50 rounded px-3 py-1 font-sans text-[32px] md:text-[48px] font-bold text-white uppercase tracking-tighter w-[300px] focus:outline-none focus:border-toxic-purple"
                  autoFocus
                  disabled={editLoading}
                />
                <button 
                  onClick={handleUpdateName}
                  disabled={editLoading}
                  className="p-2 bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded transition-colors disabled:opacity-50"
                  title="Save Name"
                >
                  <Check className="w-6 h-6" />
                </button>
                <button 
                  onClick={() => setIsEditingName(false)}
                  disabled={editLoading}
                  className="p-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded transition-colors disabled:opacity-50"
                  title="Cancel"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            ) : (
              <>
                <h1 className="font-sans text-[48px] font-bold text-on-surface uppercase tracking-tighter leading-none">{player.name}</h1>
                {player.tag && player.tag === "PRO" && <Verified className="text-[#9d4edd] w-8 h-8 fill-[#9d4edd]" />}
                
                {((user && user.username.toLowerCase() === player.name.toLowerCase()) || (user && ['notprx'].includes(user.username.toLowerCase()))) && (
                  <button 
                    onClick={() => {
                      setEditNameValue(player.name);
                      setIsEditingName(true);
                    }}
                    className="p-2 ml-2 bg-surface-container hover:bg-surface-container-high rounded text-zinc-400 hover:text-toxic-purple transition-colors cursor-pointer"
                    title="Edit Display Name"
                  >
                    <Edit2 className="w-5 h-5" />
                  </button>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#9d4edd]/10 border border-[#9d4edd]/30 rounded">
              <span className="w-2 h-2 rounded-full bg-[#ce8df2] animate-pulse"></span>
              <span className="font-mono text-[12px] font-bold text-[#f2daff] uppercase tracking-widest">{player.elo || "Unknown"} ELO</span>
            </div>
            <span className="font-mono text-[14px] text-on-surface-variant border-l border-[#4d4353] pl-3">Rank #{player.rank || "?"} Global</span>
          </div>
        </div>
        
        <div className="flex flex-col items-start md:items-end gap-1 bg-surface-container/30 border border-[#4d4353] rounded-lg p-4 backdrop-blur-[12px]">
          <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">Win/Loss Ratio</span>
          <div className="flex items-baseline gap-2">
            <span className="font-sans text-[32px] font-semibold text-on-surface leading-none">{player.winrate || "0%"}</span>
            {/* Keeping the +2.1% placeholder as a visual flair unless history is stored */}
            <span className="font-mono text-[14px] text-[#ce8df2]">+2.1%</span>
          </div>
        </div>
      </header>

      {/* Stats Grid (Bento/Glassmorphism style) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        <StatCard title="HS Accuracy %" value={player.hs || "0%"} icon={<Target />} />
        <StatCard title="Highest Killstreak" value={"N/A"} icon={<Flame />} />
        <StatCard title="Total Matches" value={player.matches?.toString() || "0"} icon={<Zap />} />
        <StatCard title="Total Damage" value={"N/A"} icon={<Swords />} />
        <StatCard title="Games Won" value={gamesWon.toString()} icon={<Trophy />} />
        <StatCard title="Avg. Life" value={"N/A"} icon={<Timer />} />
      </section>

      {/* Performance Graph Section - Since we don't have historical data in the DB yet, keeping visual graph */}
      <section className="flex flex-col gap-3 mt-4">
        <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">Performance History</h3>
        <div className="w-full bg-surface-container/30 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-6 h-[300px] flex flex-col relative overflow-hidden">
          <div className="flex justify-between items-center mb-6">
            <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">Elo Progression (Last 30 Days)</span>
            <div className="flex gap-2 items-center">
              <span className="w-2 h-2 rounded-full bg-[#9d4edd]"></span>
              <span className="font-mono text-[14px] text-on-surface">Rank Rating</span>
            </div>
          </div>
          
          <div className="flex-grow w-full relative opacity-50 grayscale transition-all hover:grayscale-0 hover:opacity-100">
            <div className="absolute inset-0 flex flex-col justify-between z-0">
              <div className="w-full border-t border-[#4d4353]/30 h-0"></div>
              <div className="w-full border-t border-[#4d4353]/30 h-0"></div>
              <div className="w-full border-t border-[#4d4353]/30 h-0"></div>
              <div className="w-full border-t border-[#4d4353]/30 h-0"></div>
            </div>
            
            <svg className="absolute inset-0 w-full h-full z-10 preserve-3d" preserveAspectRatio="none" viewBox="0 0 1000 200">
              <defs>
                <linearGradient id="graphGradient" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#9d4edd" stopOpacity="0.3"></stop>
                  <stop offset="100%" stopColor="#9d4edd" stopOpacity="0"></stop>
                </linearGradient>
              </defs>
              <path d="M0,150 L100,140 L200,160 L300,120 L400,130 L500,90 L600,100 L700,60 L800,80 L900,40 L1000,20 L1000,200 L0,200 Z" fill="url(#graphGradient)"></path>
              <path className="drop-shadow-[0_0_8px_rgba(157,78,221,0.5)]" d="M0,150 L100,140 L200,160 L300,120 L400,130 L500,90 L600,100 L700,60 L800,80 L900,40 L1000,20" fill="none" stroke="#9D4EDD" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3"></path>
            </svg>
            
            <div className="absolute top-[20px] right-0 w-3 h-3 bg-background border-2 border-[#9d4edd] rounded-full z-20 transform translate-x-1.5 -translate-y-1.5 shadow-[0_0_12px_#9d4edd]"></div>
          </div>
          
          <div className="flex justify-between mt-4 border-t border-[#4d4353] pt-2">
            <span className="font-mono text-[10px] text-[#998d9e]">Oct 01</span>
            <span className="font-mono text-[10px] text-[#998d9e]">Oct 15</span>
            <span className="font-mono text-[10px] text-[#998d9e]">Oct 30</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function StatCard({ title, value, icon }: { title: string, value: string, icon: React.ReactNode }) {
  return (
    <div className="bg-surface-container/40 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-6 flex flex-col gap-4 hover:bg-surface-container/60 transition-colors duration-200 ease-out relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-[#9d4edd]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
      <div className="flex justify-between items-start relative z-10 text-[#998d9e]">
        <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">{title}</span>
        {icon}
      </div>
      <div className="flex items-baseline gap-2 relative z-10">
        <span className="font-mono text-[40px] leading-none font-bold text-on-surface">{value}</span>
      </div>
    </div>
  );
}
