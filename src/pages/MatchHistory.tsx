import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ChevronRight as OpenMatch, History, Timer, Trophy, Users, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import PlayerAvatar from "../components/PlayerAvatar";
import VerifiedBadge from "../components/VerifiedBadge";
import { formatLobbyTime } from "../lib/profile-stats";

type Round = { match_id: string; played_at: string; player_count: number;
  total_match_time: number | null; total_kills: number; winner: string | null };
type Participant = { player_name: string; logged_player_name: string; avatar_url?: string;
  is_verified: boolean; score: number; deaths: number; accuracy: number; kpm: number;
  kdr: number; crouches: number; time_in_lobby: number; total_match_time: number | null;
  performance_score: number };
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Berlin",
});
function matchDate(date: string) { return dateFormat.format(new Date(date)); }
function metric(value: number | null, digits = 0) { return value == null ? "—" : Number(value).toFixed(digits); }

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
              aria-label={`Open match ${matchDate(match.played_at)}, ${match.player_count} players`}>
              <span className="match-list-date">{matchDate(match.played_at)}<span className="text-[10px] text-zinc-600 block mt-1">{match.total_kills} kills recorded</span></span>
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

function MatchDialog({ match, onClose }: { match: Round; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc("get_match_details", { p_match_id: match.match_id });
        if (error) throw error;
        if (active) setParticipants(data ?? []);
      } catch { if (active) setError(true); }
      finally { if (active) setLoading(false); }
    };
    load();
    return () => { active = false; };
  }, [match.match_id, reload]);
  return (
    <dialog ref={dialog} className="match-dialog" aria-labelledby="match-dialog-title" onCancel={onClose}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="match-dialog-content">
        <header className="flex items-start justify-between gap-4 p-5 sm:p-7 border-b border-white/10">
          <div><p className="eyebrow mb-2">Match results</p><h2 id="match-dialog-title" className="text-xl font-semibold">{matchDate(match.played_at)}</h2>
            <p className="text-xs text-zinc-500 mt-2">{match.player_count} players · Lobby duration {formatLobbyTime(match.total_match_time)}</p></div>
          <button className="icon-button" aria-label="Close match" onClick={onClose} autoFocus><X size={18} /></button>
        </header>
        {loading ? <p role="status" className="text-center p-12 text-zinc-500">Loading player stats...</p>
          : error ? <div className="p-12 text-center"><p className="text-zinc-400">Player stats couldn't be loaded.</p><button className="button-secondary mt-4" onClick={() => setReload(value => value + 1)}>Try again</button></div>
          : !participants.length ? <p className="p-12 text-zinc-500">This match is no longer available.</p>
          : <><p className="sm:hidden text-[10px] text-zinc-500 px-5 py-3">Swipe to see all stats.</p><div className="overflow-x-auto">
            <table className="leaderboard-table match-results w-full text-left text-xs">
              <caption className="sr-only">All participants ordered by kills. Winning score: 50 kills.</caption>
              <thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Deaths</th><th>Accuracy</th><th>KPM</th><th>K/D</th><th>Crouches</th><th>Time in lobby</th><th>Round rating</th></tr></thead>
              <tbody>{participants.map((player, index) => <tr key={`${player.logged_player_name}-${index}`} className={player.score >= 50 ? "match-winner-row" : ""}>
                <td>{player.score >= 50 ? <Trophy size={15} className="text-[#dbc18a]" aria-label="Winner" /> : index + 1}</td>
                <td><div className="flex items-center gap-2 whitespace-nowrap"><PlayerAvatar name={player.player_name} avatarUrl={player.avatar_url} className="player-avatar" />
                  <Link to={`/profile/${encodeURIComponent(player.player_name)}`} onClick={onClose} className="font-semibold hover:text-toxic-purple truncate max-w-44" title={player.logged_player_name}>{player.logged_player_name}</Link>
                  <VerifiedBadge verified={player.is_verified} compact /></div>
                  {player.logged_player_name !== player.player_name && <span className="block text-[10px] text-zinc-500 mt-1 pl-10">{player.player_name}</span>}
                </td><td className="font-semibold">{player.score}</td><td>{player.deaths}</td><td>{metric(player.accuracy, 2)}%</td><td>{metric(player.kpm, 2)}</td><td>{metric(player.kdr, 2)}</td>
                <td>{player.crouches}</td><td>{formatLobbyTime(player.time_in_lobby)}</td><td className="text-toxic-purple font-semibold">{metric(player.performance_score)}</td>
              </tr>)}</tbody>
            </table>
          </div></>}
      </div>
    </dialog>
  );
}
