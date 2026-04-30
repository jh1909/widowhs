import { Star, User, Key, MessageSquare, Radio, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../lib/AuthContext";
import { supabase } from "../lib/supabase";

type Player = { 
  rank: number | string; 
  name: string; 
  tag?: string; 
  elo: string; 
  winrate: string; 
  hs: string; 
  matches: number | string;
};

export default function Leaderboard() {
  const { user } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [copied, setCopied] = useState(false);
  const [leaderboardData, setLeaderboardData] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const { data, error } = await supabase
          .from("players")
          .select("*")
          .order("rank", { ascending: true });

        if (error) {
          throw error;
        }

        if (data && data.length > 0) {
          setLeaderboardData(data);
        } else {
          // Provide mock data if table is empty or missing, just to show how it looks
          // But actually, it's better to show an empty state.
          setLeaderboardData([]);
        }
      } catch (err: any) {
        console.error("Failed to load leaderboard from Supabase", err);
        setError("Failed to load leaderboard. Please make sure the 'players' table exists in your Supabase project.");
      } finally {
        setLoading(false);
      }
    }

    fetchLeaderboard();
  }, []);

  // Derive real user stats based on auth status and leaderboard data
  const currentUserStats = useMemo(() => {
    if (!user) return null;
    const found = leaderboardData.find(
      (p) => p.name.toLowerCase() === user.username.toLowerCase()
    );
    if (!found) {
      return {
        rank: "-",
        name: user.username,
        tag: "",
        elo: "-",
        winrate: "-",
        hs: "-",
        matches: 0
      };
    }
    return found;
  }, [user, leaderboardData]);

  const filteredData = useMemo(() => {
    return leaderboardData.filter((player) =>
      player.name.toLowerCase().includes(searchTerm.toLowerCase()) && Number(player.rank) < 999999
    );
  }, [searchTerm, leaderboardData]);

  const totalPages = Math.ceil(filteredData.length / itemsPerPage);
  
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredData.slice(start, start + itemsPerPage);
  }, [filteredData, currentPage]);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  return (
    <main className="flex-grow pt-10 pb-12 px-4 md:px-8 max-w-[1440px] mx-auto w-full grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Left/Main Column: Leaderboard */}
      <div className="lg:col-span-3 flex flex-col gap-6">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="font-sans text-4xl md:text-[48px] font-extrabold tracking-tight text-on-surface">Global Rankings</h1>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 w-4 h-4" />
            <input
              className="w-full bg-surface-container-low border border-toxic-purple/20 rounded-md py-2 pl-9 pr-4 text-sm text-on-surface focus:outline-none focus:border-toxic-purple focus:ring-1 focus:ring-toxic-purple/30 transition-all placeholder:text-zinc-600"
              placeholder="Search players..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>
        </header>

        <div className="glass-panel rounded-md glow-top overflow-hidden border border-toxic-purple/10 flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr className="border-b border-toxic-purple/10 text-on-surface-variant text-[11px] font-bold uppercase tracking-widest bg-surface-container-low">
                  <th className="py-4 px-6 w-16 text-center">Rank</th>
                  <th className="py-4 px-6">Player</th>
                  <th className="py-4 px-6 text-right">Score</th>
                  <th className="py-4 px-6 text-right">KDR</th>
                  <th className="py-4 px-6 text-right">Acc%</th>
                  <th className="py-4 px-6 text-right">KPM</th>
                  <th className="py-4 px-6 text-right">Elo</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[13px] font-medium text-on-surface">
                {/* Loading State */}
                {loading && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500 font-sans">
                      Loading player data...
                    </td>
                  </tr>
                )}
                
                {/* Error State */}
                {!loading && error && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-red-400 font-sans">
                      {error}
                    </td>
                  </tr>
                )}

                {/* Current User Stats */}
                {!loading && !error && !searchTerm && currentUserStats && (
                  <tr className="bg-toxic-purple/10 border-b border-toxic-purple/30 relative">
                    <td className="py-4 px-6 text-center text-toxic-purple font-bold">
                      {Number(currentUserStats.rank) >= 999999 ? "-" : currentUserStats.rank}
                    </td>
                    <td className="py-4 px-6 flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-surface-container-highest border border-toxic-purple/20 flex items-center justify-center overflow-hidden">
                         <img
                          alt="Avatar"
                          className="w-full h-full object-cover"
                          src="https://images.unsplash.com/photo-1566577739112-5180d4bf9390?q=80&w=2000&auto=format&fit=crop"
                        />
                      </div>
                      <Link to={`/profile/${currentUserStats.name.toLowerCase()}`} className="font-bold text-white hover:text-toxic-purple transition-colors">
                        {currentUserStats.name} (You)
                      </Link>
                      <span className="px-1.5 py-0.5 bg-toxic-purple/20 text-[#f2daff] text-[10px] rounded border border-toxic-purple/30">
                        {currentUserStats.tag}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right font-semibold text-[#f2daff]">{currentUserStats.score || "-"}</td>
                    <td className="py-4 px-6 text-right">{currentUserStats.kdr || "-"}</td>
                    <td className="py-4 px-6 text-right">{currentUserStats.accuracy || "-"}</td>
                    <td className="py-4 px-6 text-right text-on-surface-variant">{currentUserStats.kpm || "-"}</td>
                    <td className="py-4 px-6 text-right text-purple-400 font-semibold">{currentUserStats.elo || "-"}</td>
                  </tr>
                )}

                {/* Paginated Leaderboard */}
                {paginatedData.length > 0 ? (
                  paginatedData.map((player: any) => (
                    <tr
                      key={player.name}
                      className={`
                        relative group transition-colors border-b border-toxic-purple/10
                        ${player.rank === 1 ? 'toxic-glow bg-toxic-purple/5' : 'hover:bg-surface-container-highest'}
                      `}
                    >
                      <td className="py-4 px-6 text-center text-zinc-400">
                        {player.rank === 1 ? (
                          <div className="flex items-center justify-center gap-1">
                            <Star className="text-toxic-purple w-4 h-4 fill-toxic-purple" />
                            <span className="text-purple-400 font-bold">1</span>
                          </div>
                        ) : (
                          Number(player.rank) >= 999999 ? "-" : player.rank
                        )}
                      </td>
                      <td className="py-4 px-6 flex items-center gap-3">
                        {player.rank === 1 ? (
                          <img
                            alt="Avatar"
                            className="w-8 h-8 rounded border border-toxic-purple/50 object-cover"
                            src="https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=2070&auto=format&fit=crop"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded bg-surface-container-high border border-toxic-purple/10 flex items-center justify-center">
                            <User className="text-zinc-500 w-4 h-4" />
                          </div>
                        )}
                        
                        <Link to={`/profile/${player.name.toLowerCase()}`} className="font-bold text-zinc-300 group-hover:text-purple-300 transition-colors">
                          {player.name}
                        </Link>
                        
                        {player.tag && (
                          <span className="px-1.5 py-0.5 bg-toxic-purple/20 text-purple-400 text-[10px] rounded border border-toxic-purple/30">
                            {player.tag}
                          </span>
                        )}
                      </td>
                      <td className={`py-4 px-6 text-right font-semibold ${player.rank === 1 ? 'text-purple-300' : ''}`}>
                        {player.score || "-"}
                      </td>
                      <td className={`py-4 px-6 text-right ${player.rank === 1 ? 'text-green-400' : ''}`}>
                        {player.kdr || "-"}
                      </td>
                      <td className={`py-4 px-6 text-right ${player.rank === 1 ? 'text-purple-400' : ''}`}>
                        {player.accuracy || "-"}
                      </td>
                      <td className="py-4 px-6 text-right text-on-surface-variant">
                        {player.kpm || "-"}
                      </td>
                      <td className={`py-4 px-6 text-right font-semibold ${player.rank === 1 ? 'text-toxic-purple font-bold' : 'text-purple-400/80'}`}>
                        {player.elo || "-"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500 font-sans">
                      No players found matching "{searchTerm}"
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 bg-surface-container-low border-t border-toxic-purple/10">
              <span className="text-xs text-zinc-500 font-sans">
                Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, filteredData.length)} of {filteredData.length} players
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="p-1.5 rounded-md border border-toxic-purple/20 text-zinc-400 hover:text-toxic-purple hover:bg-toxic-purple/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                    <button
                      key={page}
                      onClick={() => handlePageChange(page)}
                      className={`
                        w-7 h-7 rounded-md text-xs font-mono font-bold flex items-center justify-center transition-colors
                        ${currentPage === page 
                          ? 'bg-toxic-purple text-white shadow-[0_0_10px_rgba(168,85,247,0.4)]' 
                          : 'border border-toxic-purple/10 text-zinc-400 hover:text-toxic-purple hover:bg-toxic-purple/5'
                        }
                      `}
                    >
                      {page}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="p-1.5 rounded-md border border-toxic-purple/20 text-zinc-400 hover:text-toxic-purple hover:bg-toxic-purple/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Widgets */}
      <aside className="flex flex-col gap-6">
        {/* Lobby Code Widget */}
        <div className="glass-panel rounded-md glow-top p-4">
          <h3 className="font-sans font-bold text-on-surface mb-4 flex items-center gap-2 text-sm uppercase tracking-widest">
            <Key className="text-toxic-purple w-[18px] h-[18px]" /> Lobby Code
          </h3>
          <div className="flex items-center gap-2 bg-surface-container-lowest border border-toxic-purple/20 rounded-md p-2">
            <span className="font-mono text-[13px] text-purple-300 tracking-widest flex-grow text-center">TCG2W</span>
            <button 
              onClick={() => {
                navigator.clipboard.writeText("TCG2W");
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="bg-toxic-purple/10 hover:bg-toxic-purple/20 text-purple-400 p-1.5 rounded transition-colors border border-toxic-purple/30 cursor-pointer flex items-center justify-center w-8 h-8" 
              title="Copy Code"
            >
              {copied ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-check text-green-400"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              )}
            </button>
          </div>
        </div>

        {/* Join Discord Widget */}
        <div className="glass-panel rounded-md glow-top p-4 bg-gradient-to-br from-purple-900/20 to-transparent border-toxic-purple/30">
          <h3 className="font-sans font-bold text-white mb-2 text-lg">Join the Elite</h3>
          <a href="https://discord.gg/PKYGBFV" target="_blank" rel="noopener noreferrer" className="w-full bg-[#A855F7] hover:bg-[#842bd2] text-white font-bold py-2 px-4 rounded-md transition-colors flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(168,85,247,0.3)] cursor-pointer">
            <MessageSquare className="w-5 h-5" /> Join Discord
          </a>
        </div>

        {/* Live Lobbies Widget */}
        <div className="glass-panel rounded-md glow-top p-4">
          <h3 className="font-sans font-bold text-on-surface mb-4 flex items-center gap-2 text-sm uppercase tracking-widest">
            <Radio className="text-green-500 w-[18px] h-[18px]" /> Live Lobbies
          </h3>
          <div className="flex flex-col gap-3">
            {/* Mini Status Card 1 */}
            <div className="border border-toxic-purple/10 rounded p-3 bg-surface-container-low hover:border-toxic-purple/30 transition-colors cursor-pointer">
              <div className="flex justify-between items-center mb-2">
                <span className="font-sans text-[11px] font-bold text-on-surface">EU - Frankfurt 1</span>
                <span className="flex items-center gap-1 text-[10px] text-green-400 font-bold uppercase">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div> Live
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div className="font-mono text-[13px] text-on-surface-variant">Avg Elo: <span className="text-purple-300">3.1k</span></div>
                <div className="font-sans text-[12px] text-zinc-500">11/12</div>
              </div>
            </div>

            {/* Mini Status Card 2 */}
            <div className="border border-toxic-purple/10 rounded p-3 bg-surface-container-low hover:border-toxic-purple/30 transition-colors cursor-pointer">
              <div className="flex justify-between items-center mb-2">
                <span className="font-sans text-[11px] font-bold text-on-surface">NA - East 2</span>
                <span className="flex items-center gap-1 text-[10px] text-green-400 font-bold uppercase">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div> Live
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div className="font-mono text-[13px] text-on-surface-variant">Avg Elo: <span className="text-purple-300">2.8k</span></div>
                <div className="font-sans text-[12px] text-zinc-500">8/12</div>
              </div>
            </div>

            {/* Mini Status Card 3 */}
            <div className="border border-toxic-purple/10 rounded p-3 bg-surface-container-low opacity-50">
              <div className="flex justify-between items-center mb-2">
                <span className="font-sans text-[11px] font-bold text-on-surface">KR - Seoul 1</span>
                <span className="flex items-center gap-1 text-[10px] text-zinc-500 font-bold uppercase">
                  <div className="w-1.5 h-1.5 bg-zinc-600 rounded-full"></div> Match in Progress
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div className="font-mono text-[13px] text-on-surface-variant">Avg Elo: <span className="text-purple-300">3.4k</span></div>
                <div className="font-sans text-[12px] text-zinc-500">12/12</div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </main>
  );
}
