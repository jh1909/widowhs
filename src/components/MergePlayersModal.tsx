import { useState, useEffect, useRef } from "react";
import { GitMerge, X, AlertTriangle, CheckCircle, Search, Loader2, ArrowRight, UserPlus, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { confirmPlayerMerge } from "../lib/player-moderation";

type PlayerInfo = {
  name: string;
  rank: number | string | null;
  elo: string | null;
  matches: number | null;
  is_verified?: boolean;
  user_id?: string | null;
  is_banned?: boolean;
  bnet_accounts?: string[] | null;
};

interface MergePlayersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMerged: () => void;
  initialSource?: string | null;
  initialTarget?: string | null;
}

export default function MergePlayersModal({
  isOpen,
  onClose,
  onMerged,
  initialSource,
  initialTarget,
}: MergePlayersModalProps) {
  const [targetName, setTargetName] = useState("");
  const [targetPlayer, setTargetPlayer] = useState<PlayerInfo | null>(null);
  const [targetSearch, setTargetSearch] = useState("");
  const [targetResults, setTargetResults] = useState<PlayerInfo[]>([]);
  const [isSearchingTarget, setIsSearchingTarget] = useState(false);

  const [sourceNameInput, setSourceNameInput] = useState("");
  const [sourceResults, setSourceResults] = useState<PlayerInfo[]>([]);
  const [isSearchingSource, setIsSearchingSource] = useState(false);
  const [selectedSources, setSelectedSources] = useState<PlayerInfo[]>([]);

  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Initialize with props
  useEffect(() => {
    if (!isOpen) {
      setTargetName("");
      setTargetPlayer(null);
      setTargetSearch("");
      setTargetResults([]);
      setSourceNameInput("");
      setSourceResults([]);
      setSelectedSources([]);
      setError(null);
      setSuccessMsg(null);
      setProgressMsg(null);
      return;
    }

    if (initialTarget) {
      setTargetName(initialTarget);
      void lookupPlayer(initialTarget).then((p) => {
        if (p) {
          setTargetPlayer(p);
          setTargetSearch(p.name);
        }
      });
    }

    if (initialSource) {
      void lookupPlayer(initialSource).then((p) => {
        if (p) setSelectedSources([p]);
      });
    }
  }, [isOpen, initialTarget, initialSource]);

  async function lookupPlayer(name: string): Promise<PlayerInfo | null> {
    try {
      const { data, error } = await supabase
        .from("players")
        .select("name, rank, elo, matches, is_verified, user_id, is_banned, bnet_accounts")
        .ilike("name", name.trim())
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    } catch {
      return null;
    }
  }

  // Target search debouncing
  useEffect(() => {
    if (!targetSearch || (targetPlayer && targetPlayer.name === targetSearch)) {
      setTargetResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearchingTarget(true);
      try {
        const { data } = await supabase
          .from("players")
          .select("name, rank, elo, matches, is_verified, user_id, is_banned, bnet_accounts")
          .ilike("name", `%${targetSearch.trim()}%`)
          .order("rank", { ascending: true })
          .limit(6);
        setTargetResults(data || []);
      } catch {
        setTargetResults([]);
      } finally {
        setIsSearchingTarget(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [targetSearch, targetPlayer]);

  // Source search debouncing
  useEffect(() => {
    if (!sourceNameInput) {
      setSourceResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearchingSource(true);
      try {
        const { data } = await supabase
          .from("players")
          .select("name, rank, elo, matches, is_verified, user_id, is_banned, bnet_accounts")
          .ilike("name", `%${sourceNameInput.trim()}%`)
          .order("rank", { ascending: true })
          .limit(6);
        setSourceResults(data || []);
      } catch {
        setSourceResults([]);
      } finally {
        setIsSearchingSource(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [sourceNameInput]);

  const getMergedAccountNames = (target: PlayerInfo | null, sources: PlayerInfo[]): string[] => {
    if (!target) return [];
    const set = new Set<string>();
    set.add(target.name.toLowerCase());
    if (target.bnet_accounts) {
      target.bnet_accounts.forEach((a) => a && set.add(a.toLowerCase()));
    }
    for (const s of sources) {
      set.add(s.name.toLowerCase());
      if (s.bnet_accounts) {
        s.bnet_accounts.forEach((a) => a && set.add(a.toLowerCase()));
      }
    }
    return Array.from(set);
  };

  const addSource = (source: PlayerInfo) => {
    if (source.is_verified || source.user_id) {
      setError(`Cannot merge '${source.name}' because this profile is verified.`);
      return;
    }
    if (targetPlayer && targetPlayer.name.toLowerCase() === source.name.toLowerCase()) {
      setError(`Cannot merge '${source.name}' into itself.`);
      return;
    }
    if (selectedSources.some((s) => s.name.toLowerCase() === source.name.toLowerCase())) {
      return;
    }
    if (targetPlayer) {
      const projected = getMergedAccountNames(targetPlayer, [...selectedSources, source]);
      if (projected.length > 3) {
        setError(
          `Cannot add '${source.name}': Target player would exceed the maximum of 3 Battle.net accounts (${projected.length} accounts: Master + sources).`,
        );
        return;
      }
    }
    setError(null);
    setSelectedSources((prev) => [...prev, source]);
    setSourceNameInput("");
    setSourceResults([]);
  };

  const removeSource = (name: string) => {
    setSelectedSources((prev) => prev.filter((s) => s.name.toLowerCase() !== name.toLowerCase()));
  };

  const handleSelectTarget = (p: PlayerInfo) => {
    setTargetPlayer(p);
    setTargetName(p.name);
    setTargetSearch(p.name);
    setTargetResults([]);
    setError(null);
    // Remove from sources if it was there
    setSelectedSources((prev) => prev.filter((s) => s.name.toLowerCase() !== p.name.toLowerCase()));
  };

  const handleMerge = async () => {
    if (!targetPlayer || selectedSources.length === 0) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);

    try {
      let mergedCount = 0;
      for (const src of selectedSources) {
        setProgressMsg(`Merging '${src.name}' into '${targetPlayer.name}'...`);
        const { data, error } = await supabase.rpc("admin_merge_players", {
          p_target_name: targetPlayer.name,
          p_source_name: src.name,
        });

        confirmPlayerMerge(data, error, targetPlayer.name, src.name);
        mergedCount++;
      }

      setSuccessMsg(
        `Successfully merged ${mergedCount} account${mergedCount > 1 ? "s" : ""} into '${targetPlayer.name}'. All stats and alias names were updated.`,
      );
      setSelectedSources([]);
      onMerged();
    } catch (err: any) {
      setError(err?.message || "An error occurred while merging players.");
    } finally {
      setBusy(false);
      setProgressMsg(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#111114] border border-surface-container-highest rounded-xl p-6 max-w-xl w-full mx-auto shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-surface-container-highest">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-toxic-purple/10 border border-toxic-purple/20 flex items-center justify-center text-toxic-purple">
              <GitMerge className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sans text-lg font-bold text-white tracking-tight">
                Merge Unverified Accounts
              </h3>
              <p className="font-sans text-xs text-zinc-400">
                Combine duplicate unverified log players into one master profile.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="mt-4 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-xs flex items-start gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        <div className="space-y-6 mt-6">
          {/* Target Profile Section */}
          <div>
            <label className="block font-sans font-bold text-[11px] text-zinc-400 uppercase tracking-widest mb-1.5">
              1. Master Profile (Target)
            </label>
            <p className="text-xs text-zinc-500 mb-2">
              The primary profile that keeps its identity and receives all matches.
            </p>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 w-4 h-4" />
              <input
                type="text"
                value={targetSearch}
                onChange={(e) => {
                  setTargetSearch(e.target.value);
                  if (targetPlayer && e.target.value !== targetPlayer.name) {
                    setTargetPlayer(null);
                  }
                }}
                placeholder="Search master profile name (e.g. angela9)..."
                disabled={busy}
                className="w-full bg-surface-container border border-surface-container-highest rounded-lg pl-9 pr-4 py-2.5 text-white font-mono text-[13px] focus:border-toxic-purple focus:outline-none"
              />
              {isSearchingTarget && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 w-4 h-4 animate-spin" />
              )}
            </div>

            {targetResults.length > 0 && !targetPlayer && (
              <div className="mt-1 bg-surface-container border border-surface-container-highest rounded-lg divide-y divide-surface-container-highest/50 overflow-hidden shadow-lg z-10 relative">
                {targetResults.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => handleSelectTarget(p)}
                    className="w-full px-3 py-2 text-left hover:bg-toxic-purple/10 flex items-center justify-between font-mono text-xs text-zinc-200 transition-colors"
                  >
                    <span className="font-bold text-white">{p.name}</span>
                    <span className="text-zinc-500">
                      Rank #{p.rank ?? "-"} • {p.matches ?? 0} matches • {p.elo ?? "-"} ELO
                      {p.is_verified ? " (Verified)" : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {targetPlayer && (
              <div className="mt-2 p-3 bg-surface-container/60 border border-toxic-purple/30 rounded-lg flex items-center justify-between text-xs font-mono">
                <div>
                  <span className="font-bold text-white text-sm">{targetPlayer.name}</span>
                  <div className="text-zinc-400 mt-0.5">
                    Rank #{targetPlayer.rank ?? "-"} • {targetPlayer.matches ?? 0} matches • {targetPlayer.elo ?? "-"} ELO
                    {targetPlayer.is_verified && (
                      <span className="ml-2 text-sky-400 font-semibold">[Verified]</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTargetPlayer(null);
                    setTargetSearch("");
                  }}
                  className="text-zinc-400 hover:text-zinc-200 text-xs underline"
                >
                  Change
                </button>
              </div>
            )}
          </div>

          {/* Source Profiles Section */}
          <div>
            <label className="block font-sans font-bold text-[11px] text-zinc-400 uppercase tracking-widest mb-1.5">
              2. Unverified Profiles to Merge (Sources)
            </label>
            <p className="text-xs text-zinc-500 mb-2">
              Select one or more unverified duplicate profiles (e.g. SkippyxL, DirtBlock).
            </p>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 w-4 h-4" />
              <input
                type="text"
                value={sourceNameInput}
                onChange={(e) => setSourceNameInput(e.target.value)}
                placeholder="Search unverified player to add (e.g. SkippyxL)..."
                disabled={busy}
                className="w-full bg-surface-container border border-surface-container-highest rounded-lg pl-9 pr-4 py-2.5 text-white font-mono text-[13px] focus:border-toxic-purple focus:outline-none"
              />
              {isSearchingSource && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 w-4 h-4 animate-spin" />
              )}
            </div>

            {sourceResults.length > 0 && (
              <div className="mt-1 bg-surface-container border border-surface-container-highest rounded-lg divide-y divide-surface-container-highest/50 overflow-hidden shadow-lg z-10 relative">
                {sourceResults.map((p) => {
                  const isVerified = p.is_verified || !!p.user_id;
                  const isAlreadySelected = selectedSources.some(
                    (s) => s.name.toLowerCase() === p.name.toLowerCase(),
                  );
                  const isTarget =
                    targetPlayer && targetPlayer.name.toLowerCase() === p.name.toLowerCase();
                  const wouldExceedLimit = targetPlayer
                    ? getMergedAccountNames(targetPlayer, [...selectedSources, p]).length > 3
                    : false;

                  return (
                    <button
                      key={p.name}
                      type="button"
                      disabled={isVerified || isAlreadySelected || !!isTarget || wouldExceedLimit}
                      onClick={() => addSource(p)}
                      className={`w-full px-3 py-2 text-left flex items-center justify-between font-mono text-xs transition-colors ${
                        isVerified || isAlreadySelected || isTarget || wouldExceedLimit
                          ? "opacity-40 cursor-not-allowed bg-black/20 text-zinc-500"
                          : "hover:bg-toxic-purple/10 text-zinc-200"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <UserPlus className="w-3.5 h-3.5 text-toxic-purple" />
                        <span className="font-bold text-white">{p.name}</span>
                      </div>
                      <span className="text-zinc-500">
                        {isVerified
                          ? "Verified (cannot merge)"
                          : isTarget
                            ? "Current target"
                            : isAlreadySelected
                              ? "Already selected"
                              : wouldExceedLimit
                                ? "Exceeds 3 accounts limit (Master + sources)"
                                : `Rank #${p.rank ?? "-"} • ${p.matches ?? 0} matches • ${p.elo ?? "-"} ELO`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* List of selected sources */}
            {selectedSources.length > 0 ? (
              <div className="mt-3 space-y-2">
                <span className="text-[11px] font-sans font-bold text-zinc-500 uppercase tracking-widest">
                  Selected accounts to merge ({selectedSources.length}):
                </span>
                <div className="space-y-1.5">
                  {selectedSources.map((s) => (
                    <div
                      key={s.name}
                      className="p-2.5 bg-surface-container/40 border border-surface-container-highest rounded-lg flex items-center justify-between text-xs font-mono"
                    >
                      <div className="flex items-center space-x-2">
                        <ArrowRight className="w-3.5 h-3.5 text-zinc-500" />
                        <span className="font-bold text-zinc-200">{s.name}</span>
                        <span className="text-zinc-500 text-[11px]">
                          ({s.matches ?? 0} matches, Rank #{s.rank ?? "-"}, {s.elo ?? "-"} ELO)
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSource(s.name)}
                        disabled={busy}
                        className="text-zinc-500 hover:text-red-400 p-1 transition-colors"
                        title="Remove from merge list"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic mt-2">
                No source accounts selected yet. Search above to add unverified profiles to be combined.
              </p>
            )}
          </div>

          {/* Merge impact notice */}
          {targetPlayer && selectedSources.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3.5 text-xs text-zinc-300 space-y-2">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>What will happen:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-zinc-400">
                <li>
                  All match history and logs from{" "}
                  <strong className="text-zinc-200">
                    {selectedSources.map((s) => s.name).join(", ")}
                  </strong>{" "}
                  will transfer to <strong className="text-zinc-200">{targetPlayer.name}</strong>.
                </li>
                <li>
                  The master account (<strong className="text-zinc-200">{targetPlayer.name}</strong>) and the merged account{selectedSources.length > 1 ? "s" : ""} (
                  <strong className="text-zinc-200">
                    {selectedSources.map((s) => s.name).join(", ")}
                  </strong>
                  ) will be linked as <strong className="text-zinc-200">unverified Battle.net accounts</strong> (<code>bnet_accounts</code>, {getMergedAccountNames(targetPlayer, selectedSources).length}/3 accounts). All of them will appear under Battle.net Accounts with status <span className="text-zinc-400 font-semibold">[Not verified]</span> and can be verified through Blizzard later if claimed.
                </li>
                <li>
                  Future workshop uploads with those names will automatically credit to <strong>{targetPlayer.name}</strong>.
                </li>
                <li>
                  The standalone unverified player profiles will be permanently removed.
                </li>
              </ul>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="mt-8 pt-4 border-t border-surface-container-highest flex items-center justify-between">
          <div className="text-xs text-zinc-500 font-mono">
            {progressMsg && (
              <span className="flex items-center gap-1.5 text-toxic-purple">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {progressMsg}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-xs font-bold font-sans text-zinc-400 hover:text-white uppercase tracking-widest transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={busy || !targetPlayer || selectedSources.length === 0}
              className="px-4 py-2 text-xs font-bold font-sans bg-toxic-purple/10 text-toxic-purple hover:bg-toxic-purple hover:text-black uppercase tracking-widest rounded border border-toxic-purple/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
              <span>
                {selectedSources.length > 1
                  ? `Merge ${selectedSources.length} Accounts`
                  : "Merge Account"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
