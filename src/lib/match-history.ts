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
  performance_score?: number;
}>(sessions: T[]): T {
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

  const perfScores = sessions.map(s => Number(s.performance_score)).filter(Number.isFinite);
  const avgPerfScore = perfScores.length ? Math.round(perfScores.reduce((a, b) => a + b, 0) / perfScores.length) : undefined;

  return {
    ...sessions[0],
    score: totalScore,
    deaths: totalDeaths,
    crouches: totalCrouches,
    join_time: firstJoin,
    end_time: lastEnd,
    active_time: totalActive,
    time_in_lobby: totalLobbyTime,
    kdr: Number(kdr.toFixed(2)),
    kpm: Number(kpm.toFixed(2)),
    accuracy: Number(accuracy.toFixed(2)),
    performance_score: avgPerfScore as any,
  };
}
