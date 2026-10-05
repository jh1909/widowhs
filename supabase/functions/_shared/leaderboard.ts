type LeaderboardPlayer = {
  name: string;
  elo: string | number | null | undefined;
};

export function numericElo(value: LeaderboardPlayer["elo"]): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, "").trim();
  if (!text || text === "-") return null;
  const elo = Number(text);
  return Number.isFinite(elo) && elo >= 0 ? elo : null;
}

// Compute global positions before searching or paginating. A name tie-breaker
// keeps equal ELO scores in the same order in the browser and Edge Function.
export function rankPlayers<T extends LeaderboardPlayer>(players: T[]): (T & { rank: number })[] {
  return players
    .filter((player) => numericElo(player.elo) !== null)
    .slice()
    .sort((a, b) => {
      const difference = numericElo(b.elo)! - numericElo(a.elo)!;
      if (difference) return difference;
      const first = a.name.toLowerCase();
      const second = b.name.toLowerCase();
      return first < second ? -1 : first > second ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((player, index) => ({ ...player, rank: index + 1 }));
}
