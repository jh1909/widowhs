import {
  ArrowLeft,
  Target,
  Flame,
  Zap,
  Swords,
  Trophy,
  Timer,
  Verified,
  AlertTriangle,
  Edit2,
  Check,
  X,
  Lock,
} from "lucide-react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/AuthContext";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export default function Profile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const playerName = id ? id.toUpperCase() : "UNKNOWN";

  const [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const [historyData, setHistoryData] = useState<any[]>([]);
  const [matchHistory, setMatchHistory] = useState<any[]>([]);
  const [matchHistoryPage, setMatchHistoryPage] = useState(1);
  const matchesPerPage = 10;

  const [bnetAccounts, setBnetAccounts] = useState<string[]>([]);
  const [newBnetAccount, setNewBnetAccount] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);

  useEffect(() => {
    async function fetchPlayerData() {
      if (!id) return;

      if (id === "me" && !user) {
        setLoading(false);
        setPlayer(null);
        return;
      }

      const targetId = id === "me" && user ? user.username : id;

      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("players")
          .select("*")
          .ilike("name", targetId)
          .limit(1);

        if (error) {
          throw error;
        }

        if (data && data.length > 0) {
          const mainPlayer = data[0];
          setPlayer(mainPlayer);
          setError(null);

          if (
            mainPlayer.bnet_accounts &&
            Array.isArray(mainPlayer.bnet_accounts)
          ) {
            setBnetAccounts(mainPlayer.bnet_accounts);
          } else {
            setBnetAccounts([]);
          }

          // Fetch historical data
          const { data: history } = await supabase
            .from("player_history")
            .select("elo, created_at")
            .ilike("player_name", mainPlayer.name)
            .order("created_at", { ascending: true })
            .limit(30);

          if (history && history.length > 0) {
            const formattedHistory = history.map((h) => ({
              date: new Date(h.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              }),
              elo: h.elo,
            }));

            // Ensure there's a point for the current data
            const lastData = formattedHistory[formattedHistory.length - 1];
            const currentEloRaw = parseInt(
              mainPlayer.elo.toString().replace(/,/g, ""),
            );

            if (
              !isNaN(currentEloRaw) &&
              (!lastData || lastData.elo !== currentEloRaw)
            ) {
              formattedHistory.push({
                date: new Date().toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                }),
                elo: currentEloRaw,
              });
            }

            setHistoryData(formattedHistory);
          } else {
            const currentEloRaw = parseInt(
              mainPlayer.elo.toString().replace(/,/g, ""),
            );
            if (!isNaN(currentEloRaw)) {
              setHistoryData([
                {
                  date: new Date().toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  }),
                  elo: currentEloRaw,
                },
              ]);
            }
          }

          // Fetch Match History
          try {
            const { data: matches } = await supabase
              .from("player_matches")
              .select("*")
              .ilike("player_name", mainPlayer.name)
              .order("created_at", { ascending: false });

            if (matches) {
              setMatchHistory(matches);
            }
          } catch (e) {
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
        console.error("Failed to load player data", err);
        setError("Could not find player data.");
      } finally {
        setLoading(false);
      }
    }

    fetchPlayerData();
  }, [id, user]);

  const badges = useMemo(() => {
    if (!player) return [];
    const b = [];

    // Check various stats for badges
    if (parseFloat(player.kdr) > 2.0) {
      b.push({
        id: "slayer",
        name: "Slayer",
        icon: <Zap className="w-5 h-5 text-yellow-400" />,
        desc: "K/D Ratio over 2.0",
      });
    }
    if (parseFloat(player.accuracy) > 40) {
      b.push({
        id: "sharpshooter",
        name: "Sharpshooter",
        icon: <Target className="w-5 h-5 text-red-400" />,
        desc: "Accuracy over 40%",
      });
    }
    if (player.matches && player.matches >= 100) {
      b.push({
        id: "veteran",
        name: "Veteran",
        icon: <Timer className="w-5 h-5 text-blue-400" />,
        desc: "Played 100+ matches",
      });
    }
    if (player.crouches && player.crouches > 1000) {
      b.push({
        id: "fitness",
        name: "Squat Master",
        icon: <Swords className="w-5 h-5 text-green-400" />,
        desc: "1,000+ tactical crouches",
      });
    }
    if (Number(player.rank) <= 10) {
      b.push({
        id: "elite",
        name: "Top 10",
        icon: <Trophy className="w-5 h-5 text-toxic-purple" />,
        desc: "Reached Top 10 Global",
      });
    }

    return b;
  }, [player]);

  const handleUpdateName = async () => {
    if (!editNameValue.trim() || editNameValue.trim() === player.name) {
      setIsEditingName(false);
      return;
    }
    setEditLoading(true);
    try {
      // First check if the new name already exists
      const { data: existing, error: existError } = await supabase
        .from("players")
        .select("name")
        .ilike("name", editNameValue.trim())
        .maybeSingle();

      if (existing) {
        alert("This name is already taken by another player.");
        setEditLoading(false);
        return;
      }

      // Update the name
      const { data: updateData, error } = await supabase
        .from("players")
        .update({ name: editNameValue.trim() })
        .eq("name", player.name)
        .select();

      if (error) throw error;

      if (!updateData || updateData.length === 0) {
        throw new Error(
          "Update failed. No rows affected - this could be due to Row Level Security or a database constraint.",
        );
      }

      // Update auth metadata so we don't lose the link
      const { error: authError } = await supabase.auth.updateUser({
        data: { full_name: editNameValue.trim(), name: editNameValue.trim() },
      });

      if (authError) {
        console.error("Auth metadata update failed:", authError);
      }

      setIsEditingName(false);

      // Navigate to new URL since the ID changed
      // Instead of just navigating, we reload to ensure context is fully synced
      window.location.href = `/profile/${encodeURIComponent(editNameValue.trim())}`;
      // Force reload to the new URL so AuthContext picks up the new name from the database
      window.location.hash = `/profile/${encodeURIComponent(editNameValue.trim())}`;
      window.location.reload();
    } catch (err: any) {
      console.error("Error updating name:", err);
      alert("Failed to update name.");
    } finally {
      setEditLoading(false);
    }
  };

  const handleLinkAccount = async () => {
    const accName = newBnetAccount.trim();
    if (!accName) return;
    setLinkLoading(true);

    try {
      if (
        bnetAccounts.map((a) => a.toLowerCase()).includes(accName.toLowerCase())
      ) {
        alert("You have already added this Battle.net account.");
        setLinkLoading(false);
        return;
      }

      // Let's also ensure no one else is using this bnet account.
      // We search all players where bnet_accounts contains this name.
      const { data: existing, error: err } = await supabase
        .from("players")
        .select("name, bnet_accounts")
        .filter("bnet_accounts", "cs", `{"${accName}"}`); // Postgres contains search for arrays

      if (err) {
        console.error("Error checking existing bnet accounts:", err);
      }

      if (existing && existing.length > 0) {
        if (!existing.some((e) => e.name === player.name)) {
          alert(
            "This Battle.net account is already registered by another player.",
          );
          setLinkLoading(false);
          return;
        }
      }

      const newAccounts = [...bnetAccounts, accName];

      const { error: updateErr } = await supabase
        .from("players")
        .update({ bnet_accounts: newAccounts })
        .eq("name", player.name);

      if (updateErr) throw updateErr;

      setBnetAccounts(newAccounts);
      setNewBnetAccount("");
    } catch (e: any) {
      console.error(e);
      alert("Failed to add Battle.net account.");
    } finally {
      setLinkLoading(false);
    }
  };

  const handleRemoveAccount = async (accName: string) => {
    if (
      !confirm(
        `Are you sure you want to remove the Battle.net account '${accName}'?`,
      )
    )
      return;
    try {
      const newAccounts = bnetAccounts.filter((a) => a !== accName);
      const { error: updateErr } = await supabase
        .from("players")
        .update({ bnet_accounts: newAccounts })
        .eq("name", player.name);

      if (updateErr) throw updateErr;

      setBnetAccounts(newAccounts);
    } catch (e: any) {
      console.error(e);
      alert("Failed to remove Battle.net account.");
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

  return (
    <main className="flex-grow w-full max-w-[1280px] mx-auto px-6 py-12 flex flex-col gap-12">
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
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-[#4d4353]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            {(player.avatar_url ||
              (user &&
                user.username.toLowerCase() === player.name.toLowerCase() &&
                user.avatar_url)) && (
              <div className="w-16 h-16 rounded overflow-hidden border border-toxic-purple/50">
                <img
                  src={player.avatar_url || user?.avatar_url}
                  alt={`${player.name} avatar`}
                  className="w-full h-full object-cover"
                />
              </div>
            )}

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
                <h1 className="font-sans text-[48px] font-bold text-on-surface uppercase tracking-tighter leading-none">
                  {player.name}
                </h1>
                {player.tag && player.tag === "PRO" && (
                  <Verified className="text-[#9d4edd] w-8 h-8 fill-[#9d4edd]" />
                )}

                {((user &&
                  user.username.toLowerCase() === player.name.toLowerCase()) ||
                  (user && user.isAdmin)) && (
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
              <span className="font-mono text-[12px] font-bold text-[#f2daff] uppercase tracking-widest">
                {player.elo || "Unknown"} ELO
              </span>
            </div>
            <span className="font-mono text-[14px] text-on-surface-variant border-l border-[#4d4353] pl-3">
              Rank #{Number(player.rank) >= 999999 ? "-" : player.rank || "?"}{" "}
              Global
            </span>
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1 bg-surface-container/30 border border-[#4d4353] rounded-lg p-4 backdrop-blur-[12px]">
          <span className="font-mono text-[12px] font-bold text-on-surface-variant uppercase tracking-widest">
            K/D Ratio
          </span>
          <div className="flex items-baseline gap-2">
            <span className="font-sans text-[32px] font-semibold text-on-surface leading-none">
              {player.kdr || "0"}
            </span>
          </div>
        </div>
      </header>

      {/* Stats Grid (Bento/Glassmorphism style) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        <StatCard
          title="Accuracy %"
          value={player.accuracy || "0%"}
          icon={<Target />}
        />
        <StatCard
          title="Total Kills"
          value={player.score?.toString() || "0"}
          icon={<Flame />}
        />
        <StatCard
          title="Total Deaths"
          value={player.deaths?.toString() || "0"}
          icon={<Zap />}
        />
        <StatCard
          title="Kills per Min"
          value={player.kpm?.toString() || "0"}
          icon={<Swords />}
        />
        <StatCard
          title="Time in Lobby (s)"
          value={player.time_in_lobby?.toString() || "0"}
          icon={<Timer />}
        />
        <StatCard
          title="Crouches"
          value={player.crouches?.toString() || "0"}
          icon={<Trophy />}
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
              Elo Progression (Last 30 Days)
            </span>
            <div className="flex gap-2 items-center">
              <span className="w-2 h-2 rounded-full bg-[#9d4edd]"></span>
              <span className="font-mono text-[14px] text-on-surface">
                Rank Rating
              </span>
            </div>
          </div>

          <div className="flex-grow w-full relative h-[220px]">
            {historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={1}>
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
                    dataKey="date"
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
                    type="monotone"
                    dataKey="elo"
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
                NOT ENOUGH DATA
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
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead>
                  <tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-zinc-500 font-sans">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Score</th>
                    <th className="py-3 px-4">Deaths</th>
                    <th className="py-3 px-4">KDR</th>
                    <th className="py-3 px-4">KPM</th>
                    <th className="py-3 px-4">Acc</th>
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
                        className="border-b border-white/5 transition-colors hover:bg-white/[0.02]"
                      >
                         <td className="py-3 px-4 text-zinc-400">
                           {new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
                         </td>
                         <td className="py-3 px-4 text-white font-bold">{m.score}</td>
                         <td className="py-3 px-4">{m.deaths}</td>
                         <td className="py-3 px-4 font-bold">{m.kdr?.toFixed(2) || "-"}</td>
                         <td className="py-3 px-4">{m.kpm?.toFixed(2) || "-"}</td>
                         <td className="py-3 px-4">{m.accuracy?.toFixed(1) || "-"}%</td>
                         <td className="py-3 px-4 text-toxic-purple font-bold">
                            {m.performance_score ? Math.round(m.performance_score) : "-"}
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

      {/* Linked Accounts Section */}
      {user && player && user.id === player.user_id && (
        <section className="flex flex-col gap-3 mt-4">
          <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">
            Battle.net Accounts
          </h3>
          <div className="bg-surface-container/30 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-6 flex flex-col gap-4">
            <p className="text-zinc-400 font-mono text-sm mb-2">
              Track up to 2 actual Battle.net account names. The CSV data will
              be mapped to these exact names.
            </p>
            {bnetAccounts.length > 0 && (
              <div className="flex flex-col gap-2">
                {bnetAccounts.map((accName) => (
                  <div
                    key={accName}
                    className="flex justify-between items-center bg-surface-container/50 p-3 rounded border border-toxic-purple/20"
                  >
                    <div>
                      <span className="font-sans font-bold text-white text-lg">
                        {accName}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveAccount(accName)}
                      className="text-red-400 hover:text-red-300 font-mono text-sm uppercase tracking-widest px-2 py-1"
                      title="Remove Account"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {bnetAccounts.length < 2 && (
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={newBnetAccount}
                  onChange={(e) => setNewBnetAccount(e.target.value)}
                  placeholder="Enter exact Battle.net name (e.g. prx)"
                  className="flex-grow bg-surface-container border border-surface-container-highest rounded px-4 py-2 font-mono text-[13px] text-white focus:outline-none focus:border-toxic-purple transition-colors"
                />
                <button
                  onClick={handleLinkAccount}
                  disabled={linkLoading || !newBnetAccount.trim()}
                  className="px-6 py-2 bg-toxic-purple hover:bg-[#842bd2] text-white font-bold rounded transition-colors disabled:opacity-50 font-sans uppercase tracking-widest text-sm whitespace-nowrap cursor-pointer"
                >
                  {linkLoading ? "Adding..." : "Add Account"}
                </button>
              </div>
            )}
            {bnetAccounts.length >= 2 && (
              <p className="text-zinc-500 font-mono text-xs mt-2">
                You have reached the maximum of 2 Battle.net accounts.
              </p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
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
      <div className="flex items-baseline gap-2 relative z-10">
        <span className="font-mono text-[40px] leading-none font-bold text-on-surface">
          {value}
        </span>
      </div>
    </div>
  );
}
