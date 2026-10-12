type NumericValue = number | string | null | undefined;

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function nonNegativeNumber(value: NumericValue): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Personal participation count includes every round that the player joined.
export function crouchesPerMatch(player: {
  crouches?: NumericValue;
  matches?: NumericValue;
}): number | null {
  const crouches = nonNegativeNumber(player.crouches);
  const matches = nonNegativeNumber(player.matches);
  if (crouches === null || matches === null || matches === 0) return null;
  return crouches / matches;
}

// Aggregate totals weight short, late-joined rounds by actual playing time.
export function crouchesPerMinute(player: {
  crouches?: NumericValue;
  time_in_lobby?: NumericValue;
}): number | null {
  const crouches = nonNegativeNumber(player.crouches);
  const seconds = nonNegativeNumber(player.time_in_lobby);
  if (crouches === null || seconds === null || seconds === 0) return null;
  return crouches / (seconds / 60);
}

export function formatLobbyTime(value: NumericValue): string {
  const duration = nonNegativeNumber(value);
  if (duration === null) return "—";
  const seconds = Math.floor(duration);
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}:${remainder}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}
