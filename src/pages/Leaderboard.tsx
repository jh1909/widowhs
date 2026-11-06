import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, Crosshair, Search, Users, Info, Trophy, LoaderCircle } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "../lib/AuthContext";
import { supabase } from "../lib/supabase";
import { rankPlayers, recordHolder } from "../../supabase/functions/_shared/leaderboard";
import { isQualified } from "../../supabase/functions/_shared/elo-weight";
import PlayerAvatar from "../components/PlayerAvatar";
import VerifiedBadge from "../components/VerifiedBadge";
import { formatPlayerKdr } from "../lib/player-kdr";
import { formatLobbyTime, formatPlayerAccuracy, formatPlayerPace, type PerformanceStats } from "../lib/profile-stats";
import { getPodiumRank, podiumThemes } from "../components/ProfileRankDecoration";
import { parseRegion, regionInfo, regions, type Region } from "../lib/regions";

type Player = PerformanceStats & {
  rank: number | string; global_rank?: number | string | null; primary_region?: string | null;
  name: string; elo: string; tag?: string;
  matches: number | string; avatar_url?: string; score?: number;
  kdr?: string | number; kpm?: string | number; accuracy?: string | number;
  is_verified?: boolean;
  is_banned?: boolean | null;
  bnet_accounts?: string[] | null;
  personal_best_time?: number | string | null;
  placement_matches?: number | string | null;
};

// Community statistics are global whichever region is selected.
type GlobalStats = {
  rankedPlayers: number;
  totalKills: number;
  totalMatches: number | null;
  recordPlayer: Player | null;
};

// A loaded page remembers its region so rows are never shown under another one.
type RankingsPage = {
  region: Region | null;
  search: string;
  page: number;
  filteredCount: number;
  players: Player[];
};

export default function Leaderboard() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const region = parseRegion(searchParams.get("region"));
  const selectedRegion = regionInfo(region);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageRegion, setPageRegion] = useState(region);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [rankings, setRankings] = useState<RankingsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const itemsPerPage = 10;

  // Any region change, including back and forward, starts at page 1.
  if (pageRegion !== region) {
    setPageRegion(region);
    setCurrentPage(1);
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 200);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    async function fetchLeaderboard() {
      const offset = (currentPage - 1) * itemsPerPage;
      try {
        const rpcResult = await supabase.rpc("get_leaderboard_page", {
          p_search: debouncedSearch,
          p_limit: itemsPerPage,
          p_offset: offset,
          p_region: region,
        });
        if (!active) return;
        if (!rpcResult.error && rpcResult.data && typeof rpcResult.data === "object") {
          const payload = rpcResult.data as any;
          const matchesCount = Number(payload.total_matches);
          setStats({
            rankedPlayers: Number(payload.ranked_players) || 0,
            totalKills: Number(payload.total_kills) || 0,
            totalMatches: payload.total_matches != null && Number.isSafeInteger(matchesCount) && matchesCount >= 0 ? matchesCount : null,
            recordPlayer: payload.record_holder ?? null,
          });
          setRankings({
            region, search: debouncedSearch, page: currentPage,
            filteredCount: Number(payload.filtered_count) || 0,
            players: Array.isArray(payload.players) ? payload.players : [],
          });
          return;
        }
        // Only the server can rank within a region; never fall back to global rows.
        if (region) throw rpcResult.error ?? new Error("Invalid regional leaderboard response");

        // Fallback if the RPC is not yet installed on an older database schema.
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
        if (!active) return;
        const ranked = rankPlayers(data.filter(isQualified));
        const query = debouncedSearch.toLowerCase();
        const filtered = ranked.filter(player =>
          [player.name, ...(player.bnet_accounts ?? [])].some(name => name.toLowerCase().includes(query))
        );
        const count = Number(matchCountResult.data);
        setStats({
          rankedPlayers: ranked.length,
          totalKills: ranked.reduce((sum, player) => sum + (Number(player.score) || 0), 0),
          totalMatches: !matchCountResult.error && matchCountResult.data != null &&
            Number.isSafeInteger(count) && count >= 0 ? count : null,
          recordPlayer: recordHolder(data),
        });
        setRankings({
          region: null, search: debouncedSearch, page: currentPage,
          filteredCount: filtered.length,
          players: filtered.slice(offset, offset + itemsPerPage),
        });
      } catch (error) {
        console.error("Failed to load rankings", error);
        if (active) setError(`The ${region ? `${regionInfo(region)?.short} ` : ""}rankings couldn't be loaded. Please try again.`);
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchLeaderboard();
    return () => { active = false; };
  }, [debouncedSearch, currentPage, region, reload]);

  // If the result set shrank below the requested page, move to its last page and refetch.
  useEffect(() => {
    if (loading || error || !rankings || rankings.region !== region ||
      rankings.search !== debouncedSearch || rankings.page !== currentPage) return;
    const lastPage = Math.max(1, Math.ceil(rankings.filteredCount / itemsPerPage));
    if (currentPage > lastPage) setCurrentPage(lastPage);
  }, [loading, error, rankings, region, debouncedSearch, currentPage]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [copyState]);

  // While another region loads, the previous rows keep the table's height but stay hidden.
  const current = rankings?.region === region ? rankings : null;
  const switchingRegion = !!rankings && !current;
  const visibleRows = rankings?.players ?? [];
  const rowsRegion = rankings?.region ?? null;
  const totalFilteredCount = current?.filteredCount ?? 0;
  const totalPages = Math.ceil(totalFilteredCount / itemsPerPage);
  // Paging only follows a response for the exact search and page on screen; the
  // search debounce means `loading` alone is set too late.
  const pagingSettled = !!current && !loading && !error &&
    current.search === searchTerm.trim() && current.page === currentPage;
  const recordPlayer = stats?.recordPlayer ?? null;
  const formatStat = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-US");
  const selectRegion = (next: Region | null) => {
    if (next === region) return;
    const params = new URLSearchParams(searchParams);
    if (next) params.set("region", next); else params.delete("region");
    setSearchParams(params);
  };
  const copyCode = async () => {
    try { await navigator.clipboard.writeText("TCG2W"); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  };

  return (
    <main className="page-shell space-y-9">
      <section className="hero" aria-label="Global community statistics">
        <div className="hero-overview">
          <div className="hero-metrics">
            <Metric label="Ranked players worldwide" value={formatStat(stats?.rankedPlayers)} />
            <Metric label="Matches played worldwide" value={formatStat(stats?.totalMatches)} />
            <Metric label="Kills recorded worldwide" value={formatStat(stats?.totalKills)} />
          </div>
          <section className="record-holder" aria-label="Fastest personal best worldwide" aria-busy={loading && !stats}>
            <div className="record-holder-mark" aria-hidden="true"><Trophy size={18} strokeWidth={1.5} /></div>
            <div className="min-w-0 flex-1">
              <p className="record-holder-label">Global Record Holder</p>
              {!stats ? <p className="text-sm text-zinc-500" role="status">{loading ? "Loading record…" : "Record unavailable"}</p>
                : recordPlayer ? <div className="flex flex-wrap items-center gap-2 mt-1">
                  <Link to={`/profile/${encodeURIComponent(recordPlayer.name)}`} className="record-holder-name hover:underline break-all">{recordPlayer.name}</Link>
                  <VerifiedBadge verified={recordPlayer.is_verified} compact />
                </div> : <p className="text-sm text-zinc-500 mt-1">No winning time recorded yet.</p>}
            </div>
            {recordPlayer && <div className="text-right shrink-0">
              <p className="record-holder-time">{formatLobbyTime(recordPlayer.personal_best_time)}</p>
              <p className="text-[10px] text-zinc-500 mt-1">Fastest PB</p>
            </div>}
          </section>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_270px] gap-6 items-start">
        <section id="rankings" className="min-w-0 scroll-mt-36" aria-labelledby="rankings-title">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-5">
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 id="rankings-title" className="section-heading">{selectedRegion ? `${selectedRegion.short} rankings` : "Global rankings"}<span className="text-toxic-purple">.</span></h1>
                <span role="status" className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                  {loading && rankings && <><LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                    {switchingRegion ? `Loading ${selectedRegion?.short ?? "global"} rankings…` : "Updating…"}</>}
                </span>
              </div>
              <p className="text-[12px] text-zinc-500 mt-1">
                ELO and performance: last 100 eligible rounds. Play 10 fully eligible matches to qualify.
              </p>
              {selectedRegion && <p className="text-[12px] text-zinc-500 mt-1">
                Players whose primary region is {selectedRegion.name}, ranked among themselves. ELO still uses all their games; podium highlights stay global.
              </p>}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div role="group" aria-label="Filter rankings by primary region" className="flex p-1 rounded-lg border border-white/10 bg-surface-container-lowest">
                {[{ value: null, label: "All regions", name: undefined }, ...regions.map(option => ({ value: option.value, label: option.short, name: `${option.name} (${option.short})` }))].map(option => (
                  <button key={option.label} type="button" aria-pressed={region === option.value} onClick={() => selectRegion(option.value)}
                    aria-label={option.name} title={option.name}
                    className={`flex-auto sm:flex-none px-3 py-2 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${region === option.value ? "bg-toxic-purple/15 text-toxic-purple-light" : "text-zinc-400 hover:text-zinc-200"}`}>
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search size={15} className="absolute left-3.5 top-3.5 text-zinc-500" />
                <input aria-label="Search players and Battle.net accounts" placeholder="Player or account name..." value={searchTerm}
                  onChange={(event) => { setSearchTerm(event.target.value); setCurrentPage(1); }}
                  className="w-full sm:w-56 bg-surface-container-lowest border border-white/10 rounded-lg py-3 pl-10 pr-3 text-xs text-white placeholder:text-zinc-600 focus:border-toxic-purple/60 focus:outline-none" />
              </div>
            </div>
          </div>
          <div className="panel overflow-hidden relative" aria-busy={loading}>
            {switchingRegion && !error && <div className="absolute inset-0 z-10 grid place-items-center text-zinc-500" aria-hidden="true">
              <LoaderCircle size={18} className="animate-spin" />
            </div>}
            <div className="overflow-x-auto">
              <table className="leaderboard-table w-full text-left min-w-[330px] sm:min-w-[700px] text-[12px]">
                <caption className="sr-only">{selectedRegion ? `${selectedRegion.name} players` : "Players"} ranked by descending ELO. Your profile is highlighted.</caption>
                <thead><tr>
                  <th scope="col" className="w-16 text-center">Rank</th><th scope="col">Player</th>
                  <th scope="col" className="text-right hidden sm:table-cell">KDR</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Accuracy</th><th scope="col" className="text-right hidden sm:table-cell">KPM</th>
                  <th scope="col" className="text-right text-toxic-purple!" aria-sort="descending">ELO ↓</th>
                </tr></thead>
                <tbody className={switchingRegion && !error ? "invisible" : loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
                  {error ? (
                    <tr><td colSpan={6} className="text-center py-14!"><p className="text-zinc-400">{error}</p>
                      <button onClick={() => setReload((value) => value + 1)} className="button-secondary mt-4">Try again</button>
                    </td></tr>
                  ) : !rankings ? (
                    <tr><td colSpan={6} className="text-center text-zinc-500 py-14!" role="status">Loading rankings...</td></tr>
                  ) : visibleRows.length ? visibleRows.map((player) => {
                    const isCurrentUser = user?.username.toLowerCase() === player.name.toLowerCase();
                    // Table ranks are regional; podium styling follows the global rank.
                    const podiumRank = getPodiumRank(rowsRegion ? player.global_rank : player.global_rank ?? player.rank);
                    const rankClass = podiumRank === 1 ? "first" : podiumRank === 2 ? "second" : podiumRank === 3 ? "third" : "";
                    const playerRegion = rowsRegion ? null : regionInfo(parseRegion(player.primary_region));
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
                            {playerRegion && <span className="hidden sm:inline text-[8px] font-bold px-1.5 py-0.5 rounded border border-white/10 text-zinc-500" title={playerRegion.name}>{playerRegion.short}</span>}
                          </div>
                        </td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{formatPlayerKdr(player)}</td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{formatPlayerAccuracy(player)}</td>
                        <td className="text-right text-zinc-400 hidden sm:table-cell">{formatPlayerPace(player)}</td>
                        <td className="text-right font-bold text-toxic-purple">{player.elo}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={6} className="text-center text-zinc-500 py-14!">{rankings.search
                      ? `No ${selectedRegion ? `${selectedRegion.short} ` : ""}players found for “${rankings.search}”.`
                      : selectedRegion ? `No ranked players have set ${selectedRegion.name} as their primary region yet.`
                      : "No ranked players yet. Be the first to play."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {current && !error && totalFilteredCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-t border-white/5">
                {current.page <= totalPages && <span className="text-[10px] text-zinc-500">Showing {(current.page - 1) * itemsPerPage + 1}–{Math.min(current.page * itemsPerPage, totalFilteredCount)} of {totalFilteredCount} {selectedRegion ? `${selectedRegion.short} ` : ""}players</span>}
                {totalPages > 1 && <div className="flex items-center gap-3">
                  <button className="icon-button p-1.5!" aria-label="Previous page" disabled={!pagingSettled || currentPage <= 1}
                    onClick={() => setCurrentPage((value) => value - 1)}><ChevronLeft size={15} /></button>
                  <span className="text-[11px] text-zinc-400">{currentPage} / {totalPages}</span>
                  <button className="icon-button p-1.5!" aria-label="Next page" disabled={!pagingSettled || currentPage >= totalPages}
                    onClick={() => setCurrentPage((value) => value + 1)}><ChevronRight size={15} /></button>
                </div>}
              </div>
            )}
          </div>
          <p className="sm:hidden text-[10px] text-zinc-500 mt-3">Tap a player for accuracy, KDR and KPM.</p>
          <details className="mt-4 text-xs text-zinc-500">
            <summary className="inline-flex items-center gap-2 py-2"><Info size={13} /> How ELO works</summary>
            <p className="max-w-xl leading-7 mt-2">ELO uses your last 100 eligible rounds, ordered by match date: participation-weighted kills per minute (65%), accuracy (25%) and kill/death ratio (10%). With fewer than 100 eligible rounds, all available eligible rounds count. Join within the first 10 seconds, reach 35 kills, or play at least 3 minutes for full weight. Later joins with fewer than 15 kills and less than 1 minute are ineligible and do not use a slot. Other late joins use one slot with the higher of kills / 35 or seconds / 180 as their weight. Logs without a total duration receive full weight. Displayed performance and medals use the same window. PB, matches played and Speedrunner wins remain lifetime. Equal ELO uses the fastest PB, then player name.</p>
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
