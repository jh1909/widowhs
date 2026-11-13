import { scoreWeight } from "../../supabase/functions/_shared/elo-weight";

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

function sessionWeight(
  session: {
    score?: number;
    time_in_lobby?: number;
    active_time?: number | null;
    total_match_time?: number | null;
    elo_weight?: number | null;
  },
  fallbackTotalTime?: number | null
): number {
  if (session.elo_weight != null) return Number(session.elo_weight);
  const total = session.total_match_time ?? fallbackTotalTime ?? null;
  return scoreWeight({
    score: Number(session.score) || 0,
    time_in_lobby: Number(session.time_in_lobby) || 0,
    active_time: session.active_time ?? null,
    total_match_time: total == null ? null : Number(total),
  });
}

// Combines several sessions of the same player into a single summary record for table display.
// Eligibility and ELO weights are evaluated per session rather than on pre-summed stats.
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
  const totalScore = sessions.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
  const totalDeaths = sessions.reduce((sum, s) => sum + (Number(s.deaths) || 0), 0);
  const totalCrouches = sessions.reduce((sum, s) => sum + (Number(s.crouches) || 0), 0);
  const totalActive = sessions.reduce((sum, s) => sum + (Number(s.active_time ?? s.time_in_lobby) || 0), 0);
  const totalLobbyTime = sessions.reduce((sum, s) => sum + (Number(s.time_in_lobby) || 0), 0);

  const firstJoin = sorted[0]?.join_time ?? null;
  const lastEnd = sorted.reduce<number | null>(
    (max, s) => s.end_time == null ? max : Math.max(max ?? 0, Number(s.end_time)),
    null
  );

  const kdr = totalDeaths > 0 ? totalScore / totalDeaths : totalScore;
  const kpm = totalActive > 0 ? (totalScore / (totalActive / 60)) : (sessions.reduce((sum, s) => sum + (parseFloat(String(s.kpm)) || 0), 0) / sessions.length);

  const weightedAccSum = sessions.reduce((sum, s) => sum + (parseFloat(String(s.accuracy)) || 0) * (Number(s.active_time ?? s.time_in_lobby) || 1), 0);
  const accuracyWeight = sessions.reduce((sum, s) => sum + (Number(s.active_time ?? s.time_in_lobby) || 1), 0);
  const accuracy = accuracyWeight > 0 ? weightedAccSum / accuracyWeight : 0;

  const sessionWeights = sessions.map(s => sessionWeight(s, fallbackTotalTime));
  const eligibleSessions = sessions
    .map((s, i) => ({ session: s, weight: sessionWeights[i] }))
    .filter(({ weight }) => weight > 0);

  const aggregatedWeight = eligibleSessions.length === 0
    ? 0
    : eligibleSessions.reduce((sum, { weight }) => sum + weight, 0) / eligibleSessions.length;

  const perfSource = eligibleSessions.length > 0
    ? eligibleSessions
    : sessions.map(s => ({ session: s, weight: 1 }));
  const weightedPerfPairs = perfSource
    .map(({ session, weight }) => ({ score: Number(session.performance_score), weight }))
    .filter(({ score }) => Number.isFinite(score));
  const perfWeightSum = weightedPerfPairs.reduce((sum, { weight }) => sum + weight, 0);
  const avgPerfScore = perfWeightSum > 0
    ? Math.round(weightedPerfPairs.reduce((sum, { score, weight }) => sum + score * weight, 0) / perfWeightSum)
    : undefined;

  const totalMatchTime = sessions.reduce<number | null>(
    (max, s) => s.total_match_time == null ? max : Math.max(max ?? 0, Number(s.total_match_time)),
    fallbackTotalTime ?? null
  );

  return {
    ...sessions[0],
    score: totalScore,
    deaths: totalDeaths,
    crouches: totalCrouches,
    join_time: firstJoin,
    end_time: lastEnd,
    active_time: totalActive,
    time_in_lobby: totalLobbyTime,
    total_match_time: totalMatchTime ?? sessions[0]?.total_match_time,
    kdr: Number(kdr.toFixed(2)),
    kpm: Number(kpm.toFixed(2)),
    accuracy: Number(accuracy.toFixed(2)),
    performance_score: avgPerfScore as any,
    elo_weight: aggregatedWeight,
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
