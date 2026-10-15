export type Participation = { score: number; time_in_lobby: number; total_match_time: number | null };

// Old logs without a total duration cannot establish a late join.
export function scoreWeight(match: Participation): number {
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
