import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronRight as OpenMatch, History, Timer, Trophy, Users } from "lucide-react";
import { supabase } from "../lib/supabase";
import MatchDialog from "../components/MatchDialog";
import { formatMatchDate, type MatchSummary } from "../lib/match-history";
import { formatLobbyTime } from "../lib/profile-stats";

type Round = MatchSummary & { player_count: number; total_kills: number; winner: string | null };


export default function MatchHistory() {
  const [matches, setMatches] = useState<Round[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Round | null>(null);
  const pageSize = 25;
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc("get_global_matches", { p_limit: pageSize, p_offset: page * pageSize });
        if (error) throw error;
        if (active) { setMatches(data?.matches ?? []); setTotal(Number(data?.total) || 0); }
      } catch { if (active) setError(true); }
      finally { if (active) setLoading(false); }
    };
    load();
    return () => { active = false; };
  }, [page, reload]);

  return (
    <main className="page-shell space-y-6">
      <div className="flex flex-wrap justify-between items-end gap-4">
        <div><p className="eyebrow mb-3"><History size={13} /> All lobbies</p>
          <h1 className="section-heading">Global match history<span className="text-toxic-purple">.</span></h1>
          <p className="text-xs text-zinc-500 mt-2">Every imported round. Open a match to see all player stats.</p>
        </div>
        {!loading && !error && <span className="text-xs text-zinc-400">{total.toLocaleString("en-US")} matches</span>}
      </div>
      <section className="panel overflow-hidden" aria-label="Played matches" aria-busy={loading}>
        {loading ? <p className="p-12 text-center text-zinc-500" role="status">Loading matches...</p>
          : error ? <div className="p-12 text-center"><p className="text-zinc-400">Matches couldn't be loaded.</p>
            <button className="button-secondary mt-4" onClick={() => setReload(value => value + 1)}>Try again</button></div>
          : matches.length ? <>
            <div className="match-list-labels"><span>Date & time</span><span>Winner</span><span>Players</span><span>Duration</span><span /></div>
            {matches.map(match => <button key={match.match_id} className="match-list-row" onClick={() => setSelected(match)}
              aria-label={`Open match ${formatMatchDate(match.played_at)}, ${match.player_count} players`}>
              <span className="match-list-date">{formatMatchDate(match.played_at)}<span className="text-[10px] text-zinc-600 block mt-1">{match.total_kills} kills recorded</span></span>
              <span className="match-list-winner"><Trophy size={14} className="text-[#dbc18a] shrink-0" /><span className="truncate">{match.winner ?? "No recorded winner"}</span></span>
              <span className="match-list-stat"><Users size={13} />{match.player_count}</span>
              <span className="match-list-stat"><Timer size={13} />{formatLobbyTime(match.total_match_time)}</span>
              <OpenMatch size={16} className="text-zinc-500" />
            </button>)}
          </> : <p className="p-12 text-center text-zinc-500">No matches recorded yet.</p>}
        {!loading && !error && total > pageSize && <div className="flex items-center justify-between p-4 border-t border-white/5">
          <span className="text-xs text-zinc-500">Page {page + 1} of {Math.ceil(total / pageSize)}</span>
          <div className="flex gap-2"><button className="icon-button" disabled={page === 0} aria-label="Previous matches" onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button>
            <button className="icon-button" disabled={(page + 1) * pageSize >= total} aria-label="Next matches" onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div>
        </div>}
      </section>
      {selected && <MatchDialog key={selected.match_id} match={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
