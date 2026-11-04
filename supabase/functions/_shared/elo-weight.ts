export type Participation = {
  score: number; time_in_lobby: number; total_match_time: number | null;
  status?: string | null; afk_seconds?: number | string | null;
};

// v2 rounds (with a session status) know each player's AFK time, so they
// weigh active play: time present minus AFK time, as a share of the round.
// Under 30 s of active play counts for nothing, which drops fully AFK
// sessions, including the AFK kick. Mirrors public.match_elo_weight.
export function activeSeconds(match: Participation): number {
  return Math.max(0, match.time_in_lobby - (Number(match.afk_seconds) || 0));
}

// Old logs without a total duration cannot establish a late join.
export function scoreWeight(match: Participation): number {
  if (match.status != null) {
    const active = activeSeconds(match);
    if (active < 30) return 0;
    if (match.total_match_time == null || match.total_match_time - active <= 10) return 1;
    return Math.min(1, active / match.total_match_time);
  }
  const joinedLate = match.total_match_time != null && match.total_match_time - match.time_in_lobby > 10;
  if (!joinedLate || match.score >= 35 || match.time_in_lobby >= 180) return 1;
  if (match.score < 15 && match.time_in_lobby < 60) return 0;
  return Math.min(1, Math.max(match.score / 35, match.time_in_lobby / 180));
}

export type PlacementPlayer = { matches?: number | string; placement_matches?: number | string | null; is_banned?: boolean | null };
export function placementMatches(player: PlacementPlayer): number {
  return Math.max(0, Math.trunc(Number(player.placement_matches ?? player.matches) || 0));
}

export function isQualified(player: PlacementPlayer): boolean {
  return player.is_banned !== true && placementMatches(player) >= 10;
}
