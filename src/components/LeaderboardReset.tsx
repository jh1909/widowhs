import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/AuthContext";

export default function LeaderboardReset() {
  const { user } = useAuth();
  const [confirmation, setConfirmation] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ players: number; matches: number; history: number } | null>(null);
  const inFlight = useRef(false);

  const reset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (confirmation !== "RESET" || !user?.isAdmin || inFlight.current) return;
    inFlight.current = true;
    setResetting(true);
    setError("");
    setResult(null);
    try {
      const { data, error } = await supabase.rpc("reset_leaderboard", { p_confirmation: confirmation });
      if (error) throw error;
      setResult(data);
      setConfirmation("");
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "Reset failed. Please try again.";
      setError(message);
    } finally {
      inFlight.current = false;
      setResetting(false);
    }
  };

  return (
    <div className="p-6 lg:p-10 space-y-6 max-w-3xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Reset leaderboard</h2>
        <p className="text-xs text-zinc-500 mt-2">Start fresh for test lobbies or a new release.</p>
      </div>
      <section className="panel p-6 space-y-5 border-red-400/20">
        <h3 className="text-lg font-bold text-red-300 flex items-center gap-2"><Trash2 size={18} /> Clear all match data</h3>
        <p className="text-zinc-400 text-sm leading-6">This permanently deletes every match and ELO history entry, clears all player statistics and earned badges, and removes all current ranks. The leaderboard stays empty until new matches are imported.</p>
        <p className="text-zinc-400 text-sm leading-6">Player accounts, names, Discord pictures, linked Battle.net accounts, admin roles and bans are kept. Audit logs are kept and record this reset.</p>
        <p className="text-red-300 text-sm">This affects the entire leaderboard and cannot be undone here.</p>
        <form onSubmit={reset} className="space-y-4">
          <label htmlFor="reset-confirmation" className="block text-sm text-zinc-300">Type <strong>RESET</strong> to confirm</label>
          <input id="reset-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
            disabled={resetting || !user?.isAdmin} autoComplete="off" spellCheck={false}
            className="w-full sm:w-64 rounded-lg border border-white/15 bg-surface-container-lowest p-3 text-sm disabled:opacity-50" />
          <div>
            <button type="submit" disabled={confirmation !== "RESET" || resetting || !user?.isAdmin}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-500 rounded-lg px-5 py-3 font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
              {resetting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {resetting ? "Resetting..." : "Reset all match data"}
            </button>
          </div>
          {!user?.isAdmin && <p className="text-red-300 text-sm">Your account does not have permission to reset match data.</p>}
        </form>
        {error && <p role="alert" className="text-red-300 text-sm break-words">{error}</p>}
        {result && <div role="status" className="text-green-300 text-sm space-y-3">
          <p>Reset complete: {result.players} profiles reset, {result.matches} matches and {result.history} ELO history entries removed.</p>
          <Link to="/" className="inline-block underline underline-offset-4">View empty leaderboard</Link>
        </div>}
      </section>
    </div>
  );
}
