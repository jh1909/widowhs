import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Trophy, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import PlayerAvatar from "./PlayerAvatar";
import VerifiedBadge from "./VerifiedBadge";
import RatingWeight from "./RatingWeight";
import { formatLobbyTime } from "../lib/profile-stats";
import { byJoinTime, formatMatchDate, groupSessions, aggregateSessions, isFullyIneligible, type MatchSummary } from "../lib/match-history";

type Participant = { player_name: string; logged_player_name: string; avatar_url?: string;
  is_verified: boolean; score: number; deaths: number; accuracy: number; kpm: number;
  kdr: number; crouches: number; time_in_lobby: number; total_match_time: number | null;
  performance_score: number; played_at?: string;
  join_time?: number | null; end_time?: number | null; active_time?: number | null;
  round_winner?: string | null };
function metric(value: number | null, digits = 0) { return value == null ? "—" : Number(value).toFixed(digits); }

export default function MatchDialog({ match, onClose }: { match: MatchSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<string[]>([]);
  const [showIneligible, setShowIneligible] = useState<boolean | null>(null);
  // Several sessions of one player in this round are shown once and can be expanded.
  const groups = groupSessions(participants, player => player.player_name);
  const lobbyTime = participants.reduce<number | null>((longest, player) =>
    player.total_match_time == null ? longest : Math.max(longest ?? 0, player.total_match_time), null
  ) ?? match.total_match_time;

  const sortedGroups = [...groups].sort(
    (a, b) => aggregateSessions(b, lobbyTime).score - aggregateSessions(a, lobbyTime).score
  );
  const eligibleGroups = sortedGroups.filter(
    sessions => !isFullyIneligible(aggregateSessions(sessions, lobbyTime), lobbyTime)
  );
  const ineligibleGroups = sortedGroups.filter(
    sessions => isFullyIneligible(aggregateSessions(sessions, lobbyTime), lobbyTime)
  );
  const isExpandedIneligible = showIneligible ?? (eligibleGroups.length === 0);
  const playerCount = !loading && !error && participants.length ? groups.length : match.player_count ?? null;
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
            <p className="text-xs text-zinc-500 mt-2">
              {playerCount !== null && (
                ineligibleGroups.length > 0
                  ? `${eligibleGroups.length} players (${ineligibleGroups.length} ineligible) · `
                  : `${playerCount} players · `
              )}
              Lobby duration {formatLobbyTime(lobbyTime)}
            </p></div>
          <button className="icon-button" aria-label="Close match" onClick={onClose} autoFocus><X size={18} /></button>
        </header>
        {loading ? <p role="status" className="text-center p-12 text-zinc-500">Loading player stats...</p>
          : error ? <div className="p-12 text-center"><p className="text-zinc-400">Player stats couldn't be loaded.</p><button className="button-secondary mt-4" onClick={() => setReload(value => value + 1)}>Try again</button></div>
          : !participants.length ? <p className="p-12 text-zinc-500">This match is no longer available.</p>
          : <><p className="sm:hidden text-[10px] text-zinc-500 px-5 py-3">Swipe to see all stats.</p><div className="overflow-x-auto">
            <table className="leaderboard-table match-results w-full text-left text-xs">
              <caption className="sr-only">All participants ordered by kills. Winning score: 50 kills.</caption>
              <thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Deaths</th><th>Accuracy</th><th>KPM</th><th>K/D</th><th>Crouches</th><th>Joined</th><th>Left</th><th>Active</th><th>Round rating</th></tr></thead>
              <tbody>
                {eligibleGroups.map((sessions, index) => {
                  const player = aggregateSessions(sessions, lobbyTime);
                  const won = sessions.some(session => session.score >= 50) || player.score >= 50;
                  const expanded = open.includes(player.player_name);
                  const stats = (session: Participant) => <><td className="font-semibold">{session.score}</td><td>{session.deaths}</td><td>{metric(session.accuracy, 2)}%</td><td>{metric(session.kpm, 2)}</td><td>{metric(session.kdr, 2)}</td>
                    <td>{session.crouches}</td><td>{formatLobbyTime(session.join_time)}</td><td>{formatLobbyTime(session.end_time)}</td><td>{formatLobbyTime(session.active_time ?? session.time_in_lobby)}</td><td className="text-toxic-purple font-semibold">{metric(session.performance_score)}<RatingWeight match={{ ...session, total_match_time: session.total_match_time ?? lobbyTime }} /></td></>;
                  return <Fragment key={player.player_name}><tr className={won ? "match-winner-row" : ""}>
                    <td>{won ? <Trophy size={15} className="text-[#dbc18a]" aria-label="Winner" /> : index + 1}</td>
                    <td><div className="flex items-center gap-2 whitespace-nowrap"><PlayerAvatar name={player.player_name} avatarUrl={player.avatar_url} className="player-avatar" />
                      <Link to={`/profile/${encodeURIComponent(player.player_name)}`} onClick={onClose} className="font-semibold hover:text-toxic-purple truncate max-w-44" title={player.logged_player_name}>{player.logged_player_name}</Link>
                      <VerifiedBadge verified={player.is_verified} compact /></div>
                      {player.logged_player_name !== player.player_name && <span className="block text-[10px] text-zinc-500 mt-1 pl-10">{player.player_name}</span>}
                      {sessions.length > 1 && <button type="button" aria-expanded={expanded} className="flex items-center gap-1 text-[10px] text-toxic-purple mt-1 pl-10 hover:underline cursor-pointer"
                        onClick={() => setOpen(names => expanded ? names.filter(name => name !== player.player_name) : [...names, player.player_name])}>
                        {sessions.length} sessions <ChevronDown size={12} className={expanded ? "rotate-180" : ""} /></button>}
                    </td>{stats(player)}
                  </tr>
                  {expanded && byJoinTime(sessions).map((session, sessionIndex) => <tr key={sessionIndex} className="bg-white/[0.015] border-t border-dashed border-white/5">
                    <td /><td><span className="pl-10 text-zinc-400">Session {sessionIndex + 1}</span></td>{stats(session)}
                  </tr>)}</Fragment>;
                })}
                {ineligibleGroups.length > 0 && (
                  <>
                    <tr className="border-t border-white/10 bg-white/[0.02]">
                      <td colSpan={12} className="py-2.5 px-4">
                        <button
                          type="button"
                          aria-expanded={isExpandedIneligible}
                          onClick={() => setShowIneligible(!isExpandedIneligible)}
                          className="flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer w-full text-left"
                        >
                          <ChevronDown size={14} className={`text-zinc-500 transition-transform duration-200 ${isExpandedIneligible ? "rotate-180" : ""}`} />
                          <span>Ineligible players ({ineligibleGroups.length})</span>
                        </button>
                      </td>
                    </tr>
                    {isExpandedIneligible && ineligibleGroups.map((sessions) => {
                      const player = aggregateSessions(sessions, lobbyTime);
                      const expanded = open.includes(player.player_name);
                      const stats = (session: Participant) => <><td className="font-semibold">{session.score}</td><td>{session.deaths}</td><td>{metric(session.accuracy, 2)}%</td><td>{metric(session.kpm, 2)}</td><td>{metric(session.kdr, 2)}</td>
                        <td>{session.crouches}</td><td>{formatLobbyTime(session.join_time)}</td><td>{formatLobbyTime(session.end_time)}</td><td>{formatLobbyTime(session.active_time ?? session.time_in_lobby)}</td><td className="text-zinc-500 font-semibold">{metric(session.performance_score)}<RatingWeight match={{ ...session, total_match_time: session.total_match_time ?? lobbyTime }} /></td></>;
                      return (
                        <Fragment key={player.player_name}>
                          <tr className="text-zinc-400 bg-white/[0.01] hover:bg-white/[0.03] transition-colors border-t border-dashed border-white/5">
                            <td className="text-zinc-600 font-mono">—</td>
                            <td>
                              <div className="flex items-center gap-2 whitespace-nowrap opacity-75">
                                <PlayerAvatar name={player.player_name} avatarUrl={player.avatar_url} className="player-avatar" />
                                <Link to={`/profile/${encodeURIComponent(player.player_name)}`} onClick={onClose} className="font-medium hover:text-toxic-purple truncate max-w-44 text-zinc-400" title={player.logged_player_name}>
                                  {player.logged_player_name}
                                </Link>
                                <VerifiedBadge verified={player.is_verified} compact />
                              </div>
                              {player.logged_player_name !== player.player_name && (
                                <span className="block text-[10px] text-zinc-600 mt-1 pl-10">{player.player_name}</span>
                              )}
                              {sessions.length > 1 && (
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  className="flex items-center gap-1 text-[10px] text-toxic-purple/80 mt-1 pl-10 hover:underline cursor-pointer"
                                  onClick={() => setOpen(names => expanded ? names.filter(name => name !== player.player_name) : [...names, player.player_name])}
                                >
                                  {sessions.length} sessions <ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
                                </button>
                              )}
                            </td>
                            {stats(player)}
                          </tr>
                          {expanded && byJoinTime(sessions).map((session, sessionIndex) => (
                            <tr key={sessionIndex} className="bg-white/[0.005] border-t border-dashed border-white/5 text-zinc-500">
                              <td />
                              <td><span className="pl-10 text-zinc-500">Session {sessionIndex + 1}</span></td>
                              {stats(session)}
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div></>}
      </div>
    </dialog>
  );
}
