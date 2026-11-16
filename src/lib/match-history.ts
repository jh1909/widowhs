import { scoreWeight } from "../../supabase/functions/_shared/elo-weight";
import { combineSessions } from "../../supabase/functions/_shared/sessions";

export type MatchSummary = {
  match_id: string;
  played_at: string;
  total_match_time: number | null;
  player_count?: number;
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Berlin",
});
export function formatMatchDate(date: string) { return dateFormat.format(new Date(date)); }

// Groups rows sharing a key in first-seen order, e.g. several sessions of one player in one round.
export function groupSessions<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.values()];
}

// Join order; rows without a join time keep their order.
export function byJoinTime<T extends { join_time?: number | null }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => (a.join_time ?? 0) - (b.join_time ?? 0));
}

// Combines several sessions of the same player into a single summary record for table display.
// Round rating and ELO weight are calculated once from the summed stats.
export function aggregateSessions<T extends {
  score?: number;
  deaths?: number;
  accuracy?: number | string;
  kpm?: number | string;
  kdr?: number | string;
  crouches?: number;
  join_time?: number | null;
  end_time?: number | null;
  active_time?: number | null;
  time_in_lobby?: number;
  total_match_time?: number | null;
  performance_score?: number;
  elo_weight?: number | null;
}>(sessions: T[], fallbackTotalTime?: number | null): T & { elo_weight?: number | null } {
  if (sessions.length <= 1) return sessions[0];
  const sorted = byJoinTime(sessions);
  const combined = combineSessions(sessions, fallbackTotalTime);
  const lastEnd = sorted.reduce<number | null>(
    (max, s) => s.end_time == null ? max : Math.max(max ?? 0, Number(s.end_time)),
    null
  );

  return {
    ...sessions[0],
    score: combined.score,
    deaths: combined.deaths,
    crouches: combined.crouches,
    join_time: sorted[0]?.join_time ?? null,
    end_time: lastEnd,
    active_time: combined.active_time,
    time_in_lobby: combined.time_in_lobby,
    total_match_time: combined.total_match_time ?? sessions[0]?.total_match_time,
    kdr: Number(combined.kdr.toFixed(2)),
    kpm: Number(combined.kpm.toFixed(2)),
    accuracy: Number(combined.accuracy.toFixed(2)),
    performance_score: combined.performance_score,
    elo_weight: combined.elo_weight,
  };
}

// Determines if a player/session is completely ineligible (score weight 0).
export function isFullyIneligible(
  match: {
    score?: number;
    time_in_lobby?: number;
    active_time?: number | null;
    total_match_time?: number | null;
    elo_weight?: number | null;
  },
  fallbackTotalTime?: number | null
): boolean {
  if (match.elo_weight != null) return Number(match.elo_weight) === 0;
  const total = match.total_match_time ?? fallbackTotalTime ?? null;
  return scoreWeight({
    score: Number(match.score) || 0,
    time_in_lobby: Number(match.time_in_lobby) || 0,
    active_time: match.active_time ?? null,
    total_match_time: total == null ? null : Number(total),
  }) === 0;
}
