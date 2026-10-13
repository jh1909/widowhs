export type Participation = { score: number; time_in_lobby: number; total_match_time: number | null };

// Old logs without a total duration cannot establish a late join.
export function scoreWeight(match: Participation): number {
  const joinedLate = match.total_match_time != null && match.total_match_time - match.time_in_lobby > 10;
  if (!joinedLate || match.score >= 35 || match.time_in_lobby >= 180) return 1;
  if (match.score < 15 && match.time_in_lobby < 60) return 0;
  return Math.min(1, Math.max(match.score / 35, match.time_in_lobby / 180));
}

export type WeightedPlayer = { matches?: number | string; elo_weight_sum?: number | string | null };
export function participationWeight(player: WeightedPlayer): number {
  return Math.max(0, Number(player.elo_weight_sum ?? player.matches) || 0);
}

export function isQualified(player: WeightedPlayer): boolean {
  return participationWeight(player) >= 10 - 1e-9;
}

export function formatParticipationWeight(player: WeightedPlayer): string {
  // Never display 10/10 while the player is still in placements.
  const weight = participationWeight(player);
  return (Math.floor((weight + 1e-9) * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
