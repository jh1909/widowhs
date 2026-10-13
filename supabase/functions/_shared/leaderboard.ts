type LeaderboardPlayer = {
  name: string;
  elo: string | number | null | undefined;
  personal_best_time?: number | string | null;
};

export function numericElo(value: LeaderboardPlayer["elo"]): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, "").trim();
  if (!text || text === "-") return null;
  const elo = Number(text);
  return Number.isFinite(elo) && elo >= 0 ? elo : null;
}

export function personalBest(value: LeaderboardPlayer["personal_best_time"]): number | null {
  if (value == null || String(value).trim() === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Compute global positions before searching or paginating. Equal ELOs use the
// fastest PB; missing PBs follow recorded wins. Names resolve a remaining tie.
export function rankPlayers<T extends LeaderboardPlayer>(players: T[]): (T & { rank: number })[] {
  return players
    .filter((player) => numericElo(player.elo) !== null)
    .slice()
    .sort((a, b) => {
      const difference = numericElo(b.elo)! - numericElo(a.elo)!;
      if (difference) return difference;
      const firstBest = personalBest(a.personal_best_time);
      const secondBest = personalBest(b.personal_best_time);
      if (firstBest !== secondBest) {
        if (firstBest === null) return 1;
        if (secondBest === null) return -1;
        return firstBest - secondBest;
      }
      const first = a.name.toLowerCase();
      const second = b.name.toLowerCase();
      return first < second ? -1 : first > second ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((player, index) => ({ ...player, rank: index + 1 }));
}

// Records include all logged players; the leaderboard's placement minimum is
// applied separately. The same name fallback makes equal records deterministic.
export function recordHolder<T extends LeaderboardPlayer>(players: T[]): T | null {
  return players.filter(player => personalBest(player.personal_best_time) !== null)
    .slice().sort((a, b) => {
      const difference = personalBest(a.personal_best_time)! - personalBest(b.personal_best_time)!;
      if (difference) return difference;
      const first = a.name.toLowerCase(); const second = b.name.toLowerCase();
      return first < second ? -1 : first > second ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })[0] ?? null;
}
