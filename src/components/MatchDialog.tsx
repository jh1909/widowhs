import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Trophy, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import PlayerAvatar from "./PlayerAvatar";
import VerifiedBadge from "./VerifiedBadge";
import { formatLobbyTime } from "../lib/profile-stats";
import { formatMatchDate, type MatchSummary } from "../lib/match-history";

type Participant = { player_name: string; logged_player_name: string; avatar_url?: string;
  is_verified: boolean; score: number; deaths: number; accuracy: number; kpm: number;
  kdr: number; crouches: number; time_in_lobby: number; total_match_time: number | null;
  performance_score: number; played_at?: string };
function metric(value: number | null, digits = 0) { return value == null ? "—" : Number(value).toFixed(digits); }

export default function MatchDialog({ match, onClose }: { match: MatchSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const playerCount = match.player_count ?? (!loading && !error ? participants.length : null);
  const lobbyTime = participants.reduce<number | null>((longest, player) =>
    player.total_match_time == null ? longest : Math.max(longest ?? 0, player.total_match_time), null
  ) ?? match.total_match_time;
  const playedAt = participants.reduce((earliest, player) =>
    player.played_at && new Date(player.played_at).getTime() < new Date(earliest).getTime()
      ? player.played_at : earliest, match.played_at);
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
          <div><p className="eyebrow mb-2">Match results</p><h2 id="match-dialog-title" className="text-xl font-semibold">{formatMatchDate(playedAt)}</h2>
            <p className="text-xs text-zinc-500 mt-2">{playerCount !== null && `${playerCount} players · `}Lobby duration {formatLobbyTime(lobbyTime)}</p></div>
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
