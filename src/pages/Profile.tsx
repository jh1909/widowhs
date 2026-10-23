import {
  ArrowLeft,
  Target,
  Zap,
  Swords,
  Trophy,
  Timer,
  AlertTriangle,
  Edit2,
  Check,
  X,
  Lock,
  PersonStanding,
} from "lucide-react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { rankPlayers } from "../../supabase/functions/_shared/leaderboard";
import { isQualified, placementMatches } from "../../supabase/functions/_shared/elo-weight";
import RatingWeight from "../components/RatingWeight";
import StatMedal from "../components/StatMedal";
import { statMedals, formatMedalValue, type MedalCategory, type MedalTier, type StatMedalPlayer } from "../lib/stat-medals";
import { useAuth } from "../lib/AuthContext";
import PlayerAvatar from "../components/PlayerAvatar";
import VerifiedBadge from "../components/VerifiedBadge";
import BattleNetAccounts from "../components/BattleNetAccounts";
import MatchDialog from "../components/MatchDialog";
import ProfileDetails from "../components/ProfileDetails";
import { formatMatchDate, type MatchSummary } from "../lib/match-history";
import ProfileRankBadge, { ProfileRankFrame, getPodiumRank, podiumThemes } from "../components/ProfileRankDecoration";
import { getAchievements, type AchievementId } from "../lib/achievements";
import { formatPlayerKdr } from "../lib/player-kdr";
import { crouchesPerMatch, crouchesPerMinute, formatLobbyTime, escapeLikePattern, formatPlayerAccuracy, formatPlayerPace } from "../lib/profile-stats";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const eloDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", timeZone: "Europe/Berlin",
});

export default function Profile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, login, setUser } = useAuth();
  const playerName = id ? id.toUpperCase() : "UNKNOWN";

  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<any>(null);
  const [qualifiedRank, setQualifiedRank] = useState<number | null>(null);
  const [profileMedals, setProfileMedals] = useState<Partial<Record<MedalCategory, MedalTier>>>({});
  const [error, setError] = useState<string | null>(null);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const [historyData, setHistoryData] = useState<{ elo: number; created_at: string }[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [matchHistory, setMatchHistory] = useState<any[]>([]);
  const [personalBestTime, setPersonalBestTime] = useState<number | null>(null);
  const [matchHistoryPage, setMatchHistoryPage] = useState(1);
  const [selectedMatch, setSelectedMatch] = useState<MatchSummary | null>(null);
  const matchesPerPage = 10;

  const openMatch = (match: any) => {
    if (!match.match_id) return;
    setSelectedMatch({
      match_id: match.match_id,
      played_at: match.played_at ?? match.created_at,
      total_match_time: match.total_match_time ?? null,
    });
  };

  const [bnetAccounts, setBnetAccounts] = useState<string[]>([]);
  const [profileReload, setProfileReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function fetchPlayerData() {
      if (!id) return;
      setHistoryData([]);
      setHistoryError(null);
      setMatchHistory([]);
      setPersonalBestTime(null);
      setMatchHistoryPage(1);
      setSelectedMatch(null);
      setQualifiedRank(null);
      setProfileMedals({});

      if (id === "me" && !user) {
        setLoading(false);
        setPlayer(null);
        return;
      }

      const targetId = id === "me" && user ? user.username : id;

      setLoading(true);
      try {
        const profileQuery = supabase.from("players").select("*");
        const { data, error } = await (id === "me" && user
          ? profileQuery.eq("user_id", user.id).order("matches", { ascending: false, nullsFirst: false }).order("name", { ascending: true })
          : profileQuery.ilike("name", escapeLikePattern(targetId)))
          .limit(1);

        if (!active) return;

        if (error) {
          throw error;
        }

        if (data && data.length > 0) {
          const mainPlayer = data[0];
          setPlayer(mainPlayer);
          setError(null);
          // Only fully eligible matches qualify, exactly as on the leaderboard.
          if (isQualified(mainPlayer)) {
            try {
              // Fetch the full placed population: medals are global even when
              // a stat leader would be on another leaderboard page.
              const rankings: (StatMedalPlayer & { personal_best_time?: number | string | null })[] = [];
              for (let offset = 0; ; offset += 1000) {
                const { data: page, error: rankingError } = await supabase.from("players")
                  .select("name, elo, matches, personal_best_time, placement_matches, recent_matches, recent_kdr, recent_accuracy, recent_kpm, recent_crouches, recent_time_in_lobby, is_banned")
                  .gte("placement_matches", 10).order("name").range(offset, offset + 999);
                if (!active) return;
                if (rankingError) throw rankingError;
                rankings.push(...(page ?? []));
                if (!page || page.length < 1000) break;
              }
              const ranked = rankPlayers(rankings.filter(isQualified));
              setQualifiedRank(
                ranked.find((p) => p.name === mainPlayer.name)?.rank ?? null
              );
              setProfileMedals(statMedals(rankings).get(mainPlayer.name) ?? {});
            } catch (rankingError) {
              if (!active) return;
              console.warn("Could not load qualified ranking and stat medals", rankingError);
            }
          }

          if (
            mainPlayer.bnet_accounts &&
            Array.isArray(mainPlayer.bnet_accounts)
          ) {
            setBnetAccounts(mainPlayer.bnet_accounts);
          } else {
            setBnetAccounts([]);
          }

          // The RPC returns the latest 30 active days with their average ELO.
          const { data: history, error: historyFetchError } = await supabase
            .rpc("get_player_elo_history", { p_player_name: mainPlayer.name });

          if (!active) return;

          if (historyFetchError) {
            console.warn("Could not load ELO history", historyFetchError);
            setHistoryError("Could not load ELO history. Please try again.");
          } else setHistoryData(history ?? []);

          // Fetch Match History
          try {
            const [matchResult, bestWinResult] = await Promise.all([
              supabase.from("player_matches").select("*")
                .eq("player_name", mainPlayer.name)
                .order("played_at", { ascending: false }).order("created_at", { ascending: false }),
              // Query lifetime PB independently of the history row limit.
              supabase.from("player_matches").select("time_in_lobby")
                .eq("player_name", mainPlayer.name).gte("score", 50)
                .gt("time_in_lobby", 0)
                .order("time_in_lobby", { ascending: true }).limit(1),
            ]);
            if (!active) return;
            const { data: matches } = matchResult;
            if (matchResult.error) console.warn("Could not load match history", matchResult.error);
            if (bestWinResult.error) console.warn("Could not load personal best", bestWinResult.error);
            setPersonalBestTime(bestWinResult.data?.[0]?.time_in_lobby ?? null);

            if (matches) {
              setMatchHistory(matches);
            }
          } catch (e) {
            if (!active) return;
            console.warn("Could not load match history", e);
          }
        } else if (
          user &&
          user.username.toLowerCase() === targetId.toLowerCase()
        ) {
          setPlayer({
            name: user.username,
            tag: "",
            elo: "-",
            rank: "-",
            winrate: "0%",
            hs: "0%",
            matches: 0,
            bnet_accounts: [],
          });
          setBnetAccounts([]);
          setError(null);
        } else {
          setError("Could not find player data.");
        }
      } catch (err: any) {
        if (!active) return;
        console.error("Failed to load player data", err);
        setError("Could not find player data.");
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchPlayerData();
    return () => { active = false; };
  }, [id, user, profileReload]);

  const badges = useMemo(() => {
    if (!player) return [];
    const icons: Record<AchievementId, React.ReactNode> = {
      slayer: <Zap className="w-5 h-5 text-yellow-400" />,
      sharpshooter: <Target className="w-5 h-5 text-red-400" />,
      veteran: <Timer className="w-5 h-5 text-blue-400" />,
      fitness: <CrouchIcon className="w-5 h-5 text-green-400" />,
      "no-croucher": <PersonStanding className="w-5 h-5 text-sky-300" />,
      elite: <Trophy className="w-5 h-5 text-toxic-purple" />,
      speedrunner: <Timer className="w-5 h-5 text-emerald-400" />,
    };
    return getAchievements(player).map((badge) => ({ ...badge, icon: icons[badge.id] }));
  }, [player]);

  const handleUpdateName = async () => {
    if (!editNameValue.trim() || editNameValue.trim() === player.name) {
      setIsEditingName(false);
      return;
    }
    setEditLoading(true);
    try {
      const { data: renamedPlayer, error } = await supabase.rpc("rename_player", {
        p_current_name: player.name,
        p_new_name: editNameValue.trim(),
      });

      if (error) throw error;

      if (!renamedPlayer?.name) throw new Error("Could not rename this profile.");
      setPlayer((previous: any) => ({ ...previous, ...renamedPlayer }));
      if (renamedPlayer.user_id === user?.id) {
        setUser((previous) => previous ? { ...previous, username: renamedPlayer.name } : null);
      }
      setIsEditingName(false);
      navigate(`/profile/${encodeURIComponent(renamedPlayer.name)}`, { replace: true });
    } catch (err: any) {
      console.error("Error updating name:", err);
      alert(err.message || "Failed to update name.");
    } finally {
      setEditLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-12 items-center justify-center">
        <div className="animate-spin text-[#9d4edd] w-8 h-8 rounded-full border-2 border-t-transparent border-current"></div>
        <p className="font-mono text-zinc-500 uppercase tracking-widest text-[12px]">
          Loading profile data...
        </p>
      </main>
    );
  }

  if (id === "me" && !user) {
    return (
      <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-6 items-center justify-center">
        <Lock className="text-zinc-500 w-16 h-16" />
        <h1 className="font-sans text-[24px] font-bold text-on-surface uppercase tracking-tighter">
          Profile Not Available
        </h1>
        <p className="text-zinc-400 font-sans max-w-md text-center">
          Please log in to view your profile.
        </p>
        <button
          onClick={login}
          className="mt-4 bg-toxic-purple hover:bg-[#842bd2] text-white font-bold py-2 px-6 rounded-md transition-colors font-mono uppercase tracking-widest text-sm"
        >
          Login via Discord
        </button>
      </main>
    );
  }

  if (error || !player) {
    return (
      <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-6 items-center justify-center">
        <AlertTriangle className="text-red-500 w-16 h-16" />
        <h1 className="font-sans text-[24px] font-bold text-on-surface uppercase tracking-tighter">
          Player Not Found
        </h1>
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px] mt-4"
        >
          <ArrowLeft className="w-[18px] h-[18px]" />
          Return to Leaderboard
        </Link>
      </main>
    );
  }

  const inPlacements = placementMatches(player) < 10;
  const podiumRank = inPlacements || player.is_banned ? null : getPodiumRank(qualifiedRank);
  const averageCrouches = crouchesPerMatch(player);
  const medalFor = (category: MedalCategory) => profileMedals[category]
    ? <StatMedal tier={profileMedals[category]} category={category} value={formatMedalValue(player, category)} /> : null;

  return (
    <main className="page-shell flex flex-col gap-9">
      {/* Navigation Back Action */}
      <div className="flex items-center">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px]"
        >
          <ArrowLeft className="w-[18px] h-[18px]" />
          Back to Leaderboard
        </Link>
      </div>

      {/* Profile Header */}
      <header className={`panel profile-header${podiumRank ? ` profile-header--podium profile-header--${podiumThemes[podiumRank]}` : ""}`}>
          {podiumRank && <ProfileRankFrame rank={podiumRank} />}
        <div className="profile-header-body p-7 sm:p-9 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center gap-4">
              <PlayerAvatar
                name={String(player.name)}
                avatarUrl={player.avatar_url || (user?.id === player.user_id ? user?.avatar_url : undefined)}
                className="profile-portrait w-16 h-16 rounded-2xl border border-toxic-purple/20 bg-toxic-purple/10 text-toxic-purple font-bold text-xl"
              />

              {isEditingName ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editNameValue}
                    onChange={(e) => setEditNameValue(e.target.value)}
                    className="bg-surface-container/50 border border-toxic-purple/50 rounded px-3 py-1 font-sans text-[32px] md:text-[48px] font-bold text-white tracking-tighter w-[300px] focus:outline-none focus:border-toxic-purple"
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
                  <h1 className="font-sans text-3xl sm:text-5xl font-bold text-on-surface tracking-tight leading-none break-all">
                    {player.name}
                  </h1>
                  {player.tag && player.tag === "PRO" && (
                    <span className="text-toxic-purple border border-toxic-purple/25 rounded px-2 py-1 text-xs font-bold">PRO</span>
                  )}

                  {user && (user.id === player.user_id || user.isAdmin) && (
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
            <div className="flex flex-wrap items-center gap-3">
              <VerifiedBadge verified={player.is_verified} />
              {player.is_banned && <span className="text-xs font-bold text-red-400 border border-red-400/30 rounded px-3 py-1">Banned</span>}
              {podiumRank && <ProfileRankBadge rank={podiumRank} />}
              <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-surface-container/50 border border-[#4d4353] rounded">
                <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
                  Total Matches Played: {player.matches || 0}
                </span>
              </div>
              {!player.is_banned && !inPlacements && !podiumRank && <span className="font-mono text-[14px] text-on-surface-variant border-l border-[#4d4353] pl-3">
                Rank #{qualifiedRank ?? "—"}{" "}
                Global
              </span>}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 shrink-0">
            <div className="flex flex-col items-start md:items-end gap-2 bg-surface-container/30 border border-[#4d4353] rounded-lg p-4 backdrop-blur-[12px]">
              <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
                {inPlacements ? "Placements" : "ELO"}
              </span>
              <span className="font-sans text-[32px] font-semibold text-[#f2daff] drop-shadow-[0_0_12px_rgba(157,78,221,0.5)] leading-none text-toxic-purple">
                {inPlacements ? `${placementMatches(player)}/10` : player.elo || "0"}
              </span>
              {inPlacements && (
                <span className="font-mono text-[12px] text-on-surface-variant">
                  Fully eligible matches
                </span>
              )}
            </div>
            <div
              className="flex flex-col items-start md:items-end gap-2 bg-surface-container/30 border border-[#4d4353] rounded-lg p-4 backdrop-blur-[12px]"
              title="Fastest time from joining the lobby to reaching 50 kills"
            >
              <span className="inline-flex items-center gap-2 font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
                PB
              </span>
              <span className="font-sans text-[32px] font-semibold text-on-surface leading-none tabular-nums">
                {formatLobbyTime(personalBestTime)}
              </span>
            </div>
          </div>
        </div>
      </header>

      <ProfileDetails key={`${player.name}-${user?.id ?? 'guest'}`} playerName={player.name} isOwner={!!user && user.id === player.user_id} isAdmin={!!user?.isAdmin && !!player.user_id} />

      <p className="text-xs text-zinc-500">Performance · Last {player.recent_matches ?? 0} eligible rounds (up to 100). PB and matches played are lifetime.</p>
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        <StatCard
          title="Avg Accuracy"
          value={formatPlayerAccuracy(player)}
          icon={<Target />}
          medal={medalFor("accuracy")}
        />
        <StatCard
          title="Avg Pace"
          value={formatPlayerPace(player)}
          icon={<Timer />}
          medal={medalFor("pace")}
        />
        <StatCard
          title="Crouches / min"
          value={crouchesPerMinute(player)?.toFixed(1) ?? "—"}
          icon={<CrouchIcon />}
          detail={averageCrouches === null ? undefined : `${averageCrouches.toFixed(1)} per match on average`}
          medal={medalFor("crouches")}
        />
        <StatCard
          title="Avg K/D"
          value={formatPlayerKdr(player)}
          icon={<Swords />}
          medal={medalFor("kdr")}
        />
      </section>

      {/* Badges Section */}
      {badges.length > 0 && (
        <section className="flex flex-col gap-3 mt-4">
          <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">
            Achievements
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {badges.map((badge) => (
              <div
                key={badge.id}
                className="bg-surface-container/30 border border-[#4d4353] rounded-xl p-4 flex flex-col items-center justify-center text-center gap-2 hover:bg-surface-container/50 transition-colors"
              >
                <div className="p-3 bg-surface-container rounded-full border border-[#4d4353]/50 mb-1">
                  {badge.icon}
                </div>
                <h4 className="font-sans font-bold text-sm text-white uppercase tracking-widest leading-none">
                  {badge.name}
                </h4>
                {badge.count !== undefined && <span className="text-emerald-400 font-mono text-lg font-bold" aria-label={`${badge.count} lifetime sub-3-minute wins`}>×{badge.count.toLocaleString("en-US")}</span>}
                <p className="font-mono text-[10px] text-zinc-500">
                  {badge.desc}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Performance Graph Section - Fetches from player_history */}
      <section className="flex flex-col gap-3 mt-4">
        <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">
          Performance History
        </h3>
        <div className="w-full bg-surface-container/30 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-6 h-[300px] flex flex-col relative overflow-hidden">
          <div className="flex justify-between items-center mb-6">
            <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
              Daily average ELO · Last 30 active days
            </span>
            <div className="flex gap-2 items-center">
              <span className="w-2 h-2 rounded-full bg-[#9d4edd]"></span>
              <span className="font-mono text-[14px] text-on-surface">
                Daily average
              </span>
            </div>
          </div>

          <div className="flex-grow w-full relative h-[220px]">
            {historyError ? (
              <div className="flex flex-col items-center justify-center gap-3 w-full h-full text-sm">
                <p role="alert" className="text-zinc-400 text-center">{historyError}</p>
                <button className="button-secondary" onClick={() => setProfileReload(value => value + 1)}>Try again</button>
              </div>
            ) : historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <AreaChart
                  data={historyData}
                  margin={{ top: 10, right: 0, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="graphGradientReal"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#9d4edd" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#9d4edd" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="created_at"
                    tickFormatter={value => eloDate.format(new Date(value))}
                    stroke="#4d4353"
                    tick={{
                      fill: "#998d9e",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={30}
                  />
                  <YAxis
                    stroke="#4d4353"
                    tick={{
                      fill: "#998d9e",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                    axisLine={false}
                    tickLine={false}
                    domain={["auto", "auto"]}
                  />
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#4d4353"
                    vertical={false}
                    opacity={0.3}
                  />
                  <Tooltip
                    labelFormatter={value => eloDate.format(new Date(String(value)))}
                    formatter={value => [value, "Average ELO"]}
                    contentStyle={{
                      backgroundColor: "rgba(17, 17, 20, 0.9)",
                      border: "1px solid #4d4353",
                      borderRadius: "8px",
                      color: "#fff",
                      fontFamily: "monospace",
                    }}
                    itemStyle={{ color: "#ce8df2", fontWeight: "bold" }}
                  />
                  <Area
                    type="linear"
                    dataKey="elo"
                    dot={historyData.length === 1 ? { r: 4, fill: "#ce8df2" } : false}
                    stroke="#9d4edd"
                    strokeWidth={3}
                    fillOpacity={1}
                    fill="url(#graphGradientReal)"
                    activeDot={{
                      r: 6,
                      fill: "#111114",
                      stroke: "#9d4edd",
                      strokeWidth: 2,
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center w-full h-full text-zinc-500 font-mono text-sm">
                No ELO updates recorded yet.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Match History Section */}
      <section className="flex flex-col gap-3 mt-4">
         <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">
          Match History
        </h3>
        <div className="bg-surface-container border border-surface-container-high rounded-lg p-6">
          {matchHistory.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[1000px]">
                <thead>
                  <tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-zinc-500 font-sans">
                    <th className="py-3 px-4">Date & Time</th>
                    <th className="py-3 px-4">Score</th>
                    <th className="py-3 px-4">Deaths</th>
                    <th className="py-3 px-4">KDR</th>
                    <th className="py-3 px-4">KPM</th>
                    <th className="py-3 px-4">Acc</th>
                    <th className="py-3 px-4">Time in Lobby</th>
                    <th className="py-3 px-4">Total Lobby Time</th>
                    <th className="py-3 px-4">Perf. Score</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[13px] text-zinc-300">
                  {matchHistory
                    .slice(
                      (matchHistoryPage - 1) * matchesPerPage,
                      matchHistoryPage * matchesPerPage
                    )
                    .map((m, idx) => (
                      <tr
                        key={m.id || idx}
                        onClick={() => openMatch(m)}
                        className={`border-b border-white/5 transition-colors hover:bg-white/[0.02] ${m.match_id ? "cursor-pointer" : ""}`}
                      >
                         <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                           <button type="button" disabled={!m.match_id}
                             aria-haspopup="dialog"
                             aria-label={`Open match ${formatMatchDate(m.played_at ?? m.created_at)}`}
                             onClick={event => { event.stopPropagation(); openMatch(m); }}
                             className="hover:text-toxic-purple hover:underline focus-visible:outline focus-visible:outline-toxic-purple rounded-sm disabled:pointer-events-none">
                             {formatMatchDate(m.played_at ?? m.created_at)}
                           </button>
                         </td>
                         <td className="py-3 px-4 text-white font-bold">{m.score}</td>
                         <td className="py-3 px-4">{m.deaths}</td>
                         <td className="py-3 px-4 font-bold">{m.kdr?.toFixed(2) || "-"}</td>
                         <td className="py-3 px-4">{m.kpm?.toFixed(2) || "-"}</td>
                         <td className="py-3 px-4">{m.accuracy?.toFixed(1) || "-"}%</td>
                         <td className="py-3 px-4 whitespace-nowrap">{formatLobbyTime(m.time_in_lobby)}</td>
                         <td className="py-3 px-4 whitespace-nowrap">{formatLobbyTime(m.total_match_time)}</td>
                         <td className="py-3 px-4 text-toxic-purple font-bold">
                            {m.performance_score != null ? Math.round(m.performance_score) : "-"}
                            <RatingWeight match={m} />
                         </td>
                      </tr>
                    ))}
                </tbody>
              </table>

              {matchHistory.length > matchesPerPage && (
                <div className="flex justify-between items-center mt-4">
                  <div className="text-zinc-500 font-mono text-xs">
                    Page {matchHistoryPage} of {Math.ceil(matchHistory.length / matchesPerPage)}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setMatchHistoryPage(p => Math.max(1, p - 1))}
                      disabled={matchHistoryPage === 1}
                      className="px-3 py-1 bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-50 disabled:cursor-not-allowed rounded font-mono text-xs transition-colors"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => setMatchHistoryPage(p => Math.min(Math.ceil(matchHistory.length / matchesPerPage), p + 1))}
                      disabled={matchHistoryPage === Math.ceil(matchHistory.length / matchesPerPage)}
                      className="px-3 py-1 bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-50 disabled:cursor-not-allowed rounded font-mono text-xs transition-colors"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center w-full py-8 text-zinc-500 font-mono text-sm">
              NO MATCH HISTORY AVAILABLE
            </div>
          )}
        </div>
      </section>

      {player && <BattleNetAccounts playerName={player.name} accounts={bnetAccounts}
        isOwner={!!user && user.id === player.user_id}
        onChanged={() => setProfileReload(value => value + 1)} />}
      {selectedMatch && <MatchDialog key={selectedMatch.match_id} match={selectedMatch}
        onClose={() => setSelectedMatch(null)} />}
    </main>
  );
}

function CrouchIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="14" cy="4" r="2" />
      <path d="m12 8-3 6 7 3-3 5h5" />
      <path d="m12 8 3 4h5" />
      <path d="m9 14 4 3-3 5h4" />
    </svg>
  );
}

function StatCard({
  title,
  value,
  icon,
  detail,
  medal,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  detail?: string;
  medal?: React.ReactNode;
}) {
  return (
    <div className="bg-surface-container/40 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-6 flex flex-col gap-4 hover:bg-surface-container/60 transition-colors duration-200 ease-out relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-[#9d4edd]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
      <div className="flex justify-between items-start relative z-10 text-[#998d9e]">
        <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
          {title}
        </span>
        {icon}
      </div>
      <div className="flex items-center gap-3 relative z-10">
        <span className="font-mono text-[40px] leading-none font-bold text-on-surface">
          {value}
        </span>
        {medal && <span className="profile-stat-medal">{medal}</span>}
      </div>
      {detail && <p className="relative z-10 text-xs text-zinc-400">{detail}</p>}
    </div>
  );
}
