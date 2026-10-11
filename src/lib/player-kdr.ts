type KdrValue = number | string | null | undefined;

// players.kdr is the canonical average used by the leaderboard and rating.
export function playerKdr(player: { kdr?: KdrValue }): number | null {
  const value = player.kdr;
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : null;
}

export function formatPlayerKdr(player: { kdr?: KdrValue }): string {
  return playerKdr(player)?.toFixed(2) ?? "—";
}
