import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, Crosshair, Search, Users, Info, Trophy } from "lucide-react";
import { Link } from "react-router-dom";
import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../lib/AuthContext";
import { supabase } from "../lib/supabase";
import { rankPlayers, recordHolder } from "../../supabase/functions/_shared/leaderboard";
import { isQualified } from "../../supabase/functions/_shared/elo-weight";
import PlayerAvatar from "../components/PlayerAvatar";
import VerifiedBadge from "../components/VerifiedBadge";
import { formatPlayerKdr } from "../lib/player-kdr";
import { formatLobbyTime } from "../lib/profile-stats";
import { getPodiumRank, podiumThemes } from "../components/ProfileRankDecoration";

type Player = {
  rank: number | string; name: string; elo: string; tag?: string;
  matches: number | string; avatar_url?: string; score?: number;
  kdr?: string | number; kpm?: string | number; accuracy?: string | number;
  is_verified?: boolean;
  bnet_accounts?: string[] | null;
  personal_best_time?: number | string | null;
  elo_weight_sum?: number | string | null;
};

export default function Leaderboard() {
  const { user } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [leaderboardData, setLeaderboardData] = useState<Player[]>([]);
  const [recordPlayer, setRecordPlayer] = useState<Player | null>(null);
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const itemsPerPage = 10;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setTotalMatches(null);
    async function fetchLeaderboard() {
      try {
        const [data, matchCountResult] = await Promise.all([
          (async () => {
            const players: Player[] = [];
            for (let offset = 0; ; offset += 1000) {
              const { data, error } = await supabase.from("players").select("*").order("name").range(offset, offset + 999);
              if (error) throw error;
              players.push(...(data ?? []));
              if (!data || data.length < 1000) break;
            }
            return players;
          })(),
          supabase.rpc("get_match_count"),
        ]);
        if (matchCountResult.error) console.warn("Could not load round count", matchCountResult.error);
        if (active) {
          setRecordPlayer(recordHolder(data));
          setLeaderboardData(rankPlayers(
            ((data || []) as Player[]).filter(isQualified)
          ));
          const count = Number(matchCountResult.data);
          setTotalMatches(!matchCountResult.error && matchCountResult.data != null &&
            Number.isSafeInteger(count) && count >= 0 ? count : null);
        }
      } catch (error) {
        console.error("Failed to load rankings", error);
        if (active) setError("The rankings couldn't be loaded. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchLeaderboard();
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const filteredData = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return leaderboardData.filter(player =>
      [player.name, ...(player.bnet_accounts ?? [])].some(name => name.toLowerCase().includes(query))
    );
  }, [leaderboardData, searchTerm]);
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);
  const paginatedData = filteredData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const totalKills = leaderboardData.reduce((sum, player) => sum + (Number(player.score) || 0), 0);
  const copyCode = async () => {
    try { await navigator.clipboard.writeText("TCG2W"); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  };

  return (
    <main className="page-shell space-y-9">
      <section className="hero" aria-label="Community statistics">
        <div className="hero-overview">
          <div className="hero-metrics">
            <Metric label="Ranked players" value={loading || error ? "—" : leaderboardData.length.toLocaleString("en-US")} />
            <Metric label="Matches played" value={loading || error || totalMatches === null ? "—" : totalMatches.toLocaleString("en-US")} />
            <Metric label="Kills recorded" value={loading || error ? "—" : totalKills.toLocaleString("en-US")} />
          </div>
          <section className="record-holder" aria-label="Fastest personal best" aria-busy={loading}>
            <div className="record-holder-mark" aria-hidden="true"><Trophy size={18} strokeWidth={1.5} /></div>
            <div className="min-w-0 flex-1">
              <p className="record-holder-label">Record Holder</p>
              {loading ? <p className="text-sm text-zinc-500" role="status">Loading record…</p>
                : error ? <p className="text-sm text-zinc-500">Record unavailable</p>
                : recordPlayer ? <div className="flex flex-wrap items-center gap-2 mt-1">
                  <Link to={`/profile/${encodeURIComponent(recordPlayer.name)}`} className="record-holder-name hover:underline break-all">{recordPlayer.name}</Link>
                  <VerifiedBadge verified={recordPlayer.is_verified} compact />
                </div> : <p className="text-sm text-zinc-500 mt-1">No winning time recorded yet.</p>}
            </div>
            {recordPlayer && !loading && !error && <div className="text-right shrink-0">
              <p className="record-holder-time">{formatLobbyTime(recordPlayer.personal_best_time)}</p>
              <p className="text-[10px] text-zinc-500 mt-1">Fastest PB</p>
            </div>}
          </section>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_270px] gap-6 items-start">
        <section id="rankings" className="min-w-0 scroll-mt-36" aria-labelledby="rankings-title">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
            <div>
              <h1 id="rankings-title" className="section-heading">Global rankings<span className="text-toxic-purple">.</span></h1>
              <p className="text-[12px] text-zinc-500 mt-1">
                Sorted by ELO, then fastest PB. Earn 10 full participation weights to qualify.
              </p>
            </div>
            <div className="relative">
              <Search size={15} className="absolute left-3.5 top-3.5 text-zinc-500" />
              <input aria-label="Search players and Battle.net accounts" placeholder="Player or account name..." value={searchTerm}
                onChange={(event) => { setSearchTerm(event.target.value); setCurrentPage(1); }}
                className="w-full sm:w-56 bg-surface-container-lowest border border-white/10 rounded-lg py-3 pl-10 pr-3 text-xs text-white placeholder:text-zinc-600 focus:border-toxic-purple/60 focus:outline-none" />
            </div>
          </div>
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="leaderboard-table w-full text-left min-w-[330px] sm:min-w-[700px] text-[12px]">
                <caption className="sr-only">Players ranked by descending ELO. Your profile is highlighted.</caption>
                <thead><tr>
                  <th scope="col" className="w-16 text-center">Rank</th><th scope="col">Player</th>
                  <th scope="col" className="text-right">Kills</th><th scope="col" className="text-right hidden sm:table-cell">KDR</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Accuracy</th><th scope="col" className="text-right hidden sm:table-cell">KPM</th>
                  <th scope="col" className="text-right text-toxic-purple!" aria-sort="descending">ELO ↓</th>
                </tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="text-center text-zinc-500 py-14!" role="status">Loading rankings...</td></tr>
                  ) : error ? (
                    <tr><td colSpan={7} className="text-center py-14!"><p className="text-zinc-400">{error}</p>
                      <button onClick={() => setReload((value) => value + 1)} className="button-secondary mt-4">Try again</button>
                    </td></tr>
                  ) : paginatedData.length ? paginatedData.map((player) => {
                    const isCurrentUser = user?.username.toLowerCase() === player.name.toLowerCase();
                    const rankClass = player.rank === 1 ? "first" : player.rank === 2 ? "second" : player.rank === 3 ? "third" : "";
                    const podiumRank = getPodiumRank(player.rank);
                    return (
                      <tr key={player.name} className={[isCurrentUser ? "own-row" : "",
                        podiumRank ? `podium-row podium-row--${podiumThemes[podiumRank]}` : ""].filter(Boolean).join(" ")}>
                        <td className="text-center"><span className={`rank-badge ${rankClass}`}>{player.rank}</span></td>
                        <td>
                          <div className="flex items-center gap-3">
                            <span className="hidden sm:block">
                              <PlayerAvatar name={player.name} avatarUrl={player.avatar_url || (isCurrentUser ? user?.avatar_url : undefined)} className="player-avatar" />
                            </span>
                            <Link to={`/profile/${encodeURIComponent(player.name)}`} className="font-semibold text-zinc-200 hover:text-toxic-purple whitespace-nowrap block max-w-32 sm:max-w-none truncate">
                              {player.name}{isCurrentUser && <span className="text-toxic-purple text-[10px] ml-1.5">(You)</span>}
                            </Link>
                            <VerifiedBadge verified={player.is_verified} compact />
                            {player.tag === "PRO" && <span className="hidden sm:inline text-[8px] font-bold px-1.5 py-0.5 rounded border border-toxic-purple/20 text-toxic-purple">PRO</span>}
                          </div>
                        </td>
                        <td className="text-right text-zinc-300">{(Number(player.score) || 0).toLocaleString("en-US")}</td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{formatPlayerKdr(player)}</td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{player.accuracy ?? "—"}</td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{player.kpm ?? "—"}</td>
                        <td className="text-right font-bold text-toxic-purple">{player.elo}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={7} className="text-center text-zinc-500 py-14!">{searchTerm ? `No players found for “${searchTerm}”.` : "No ranked players yet. Be the first to play."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {!loading && !error && filteredData.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-t border-white/5">
                <span className="text-[10px] text-zinc-500">Showing {(currentPage - 1) * itemsPerPage + 1}–{Math.min(currentPage * itemsPerPage, filteredData.length)} of {filteredData.length} players</span>
                {totalPages > 1 && <div className="flex items-center gap-3">
                  <button className="icon-button p-1.5!" aria-label="Previous page" disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((value) => value - 1)}><ChevronLeft size={15} /></button>
                  <span className="text-[11px] text-zinc-400">{currentPage} / {totalPages}</span>
                  <button className="icon-button p-1.5!" aria-label="Next page" disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((value) => value + 1)}><ChevronRight size={15} /></button>
                </div>}
              </div>
            )}
          </div>
          <p className="sm:hidden text-[10px] text-zinc-500 mt-3">Tap a player for accuracy, KDR and KPM.</p>
          <details className="mt-4 text-xs text-zinc-500">
            <summary className="inline-flex items-center gap-2 py-2"><Info size={13} /> How ELO works</summary>
            <p className="max-w-xl leading-7 mt-2">ELO is a performance score based on your participation-weighted average kills per minute (65%), accuracy (25%) and kill/death ratio (10%). Join within the first 10 seconds, reach 35 kills, or play at least 3 minutes for full weight. Later joins with fewer than 15 kills and less than 1 minute are ineligible. Other late joins receive the higher of kills / 35 or seconds / 180 as their weight. Logs without a total duration receive full weight. Round ratings and general stats stay unchanged. Equal ELO uses the fastest PB, then player name.</p>
          </details>
        </section>

        <aside className="space-y-4 lg:pt-20">
          <section className="panel sidebar-card">
            <h2 className="card-label"><Crosshair size={15} className="text-toxic-purple" /> YOUR NEXT MATCH</h2>
            <div className="code-display select-all">TCG2W</div>
            <p className="text-[12px] leading-6 text-zinc-500 mb-5">Enter this code in Custom Games.</p>
            <button className="button-secondary w-full" onClick={copyCode}>
              {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
              {copyState === "copied" ? "Copied!" : "Copy lobby code"}
            </button>
            <p className="text-[11px] text-zinc-400 mt-2" aria-live="polite">{copyState === "failed" ? "Select TCG2W above to copy it manually." : ""}</p>
          </section>
          <section className="panel sidebar-card bg-linear-to-br from-toxic-purple/10 to-transparent">
            <Users size={22} className="text-toxic-purple mb-4" />
            <h2 className="font-bold text-[17px] tracking-tight">Community</h2>
            <p className="text-[12px] text-zinc-500 leading-6 my-3">Find a lobby, share your progress and meet the WIDOW HS community.</p>
            <a href="https://discord.gg/pTHzBNSyEy" target="_blank" rel="noopener noreferrer" className="button-primary w-full">
              Join Discord <ArrowUpRight size={15} />
            </a>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="metric-value">{value}</div><div className="metric-label">{label}</div></div>;
}
