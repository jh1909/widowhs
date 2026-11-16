import { scoreWeight } from "./elo-weight.ts";
import { calculateRating } from "./rating.ts";

export type Session = {
  score?: number | string; deaths?: number | string; crouches?: number | string;
  accuracy?: number | string; kpm?: number | string; kdr?: number | string;
  time_in_lobby?: number | string; active_time?: number | string | null;
  total_match_time?: number | string | null;
};

// Combines one player's sessions in a round into a single participation for provisional ELO.
// Mirrors the public.player_rounds view.
export function combineSessions(sessions: Session[], fallbackTotalTime?: number | null) {
  const num = (value: unknown) => parseFloat(String(value)) || 0;
  const active = (s: Session) => num(s.active_time ?? s.time_in_lobby);
  const score = sessions.reduce((sum, s) => sum + num(s.score), 0);
  const deaths = sessions.reduce((sum, s) => sum + num(s.deaths), 0);
  const activeTime = sessions.reduce((sum, s) => sum + active(s), 0);
  const totalMatchTime = sessions.reduce<number | null>(
    (max, s) => s.total_match_time == null ? max : Math.max(max ?? 0, num(s.total_match_time)),
    fallbackTotalTime ?? null
  );
  const kdr = deaths > 0 ? score / deaths : score;
  const kpm = activeTime > 0 ? score / (activeTime / 60) : sessions.reduce((sum, s) => sum + num(s.kpm), 0) / sessions.length;
  const accuracy = sessions.reduce((sum, s) => sum + num(s.accuracy) * (active(s) || 1), 0)
    / sessions.reduce((sum, s) => sum + (active(s) || 1), 0);
  return {
    score, deaths, kdr, kpm, accuracy,
    crouches: sessions.reduce((sum, s) => sum + num(s.crouches), 0),
    time_in_lobby: sessions.reduce((sum, s) => sum + num(s.time_in_lobby), 0),
    active_time: activeTime,
    total_match_time: totalMatchTime,
    elo_weight: scoreWeight({ score, time_in_lobby: activeTime, active_time: activeTime, total_match_time: totalMatchTime }),
    performance_score: calculateRating({ kpm, accuracy, kdr }),
  };
}
