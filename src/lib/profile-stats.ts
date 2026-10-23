type NumericValue = number | string | null | undefined;

export type PerformanceStats = {
  matches?: NumericValue; kdr?: NumericValue; accuracy?: NumericValue; kpm?: NumericValue;
  crouches?: NumericValue; time_in_lobby?: NumericValue;
  recent_matches?: NumericValue; recent_kdr?: NumericValue; recent_accuracy?: NumericValue;
  recent_kpm?: NumericValue; recent_crouches?: NumericValue; recent_time_in_lobby?: NumericValue;
};

// Fall back only before the migration; an empty recent window has no stats.
export function performanceStats(player: PerformanceStats) {
  if (player.recent_matches == null) return player;
  return { matches: player.recent_matches, kdr: player.recent_kdr,
    accuracy: player.recent_accuracy, kpm: player.recent_kpm,
    crouches: player.recent_crouches, time_in_lobby: player.recent_time_in_lobby };
}

export function formatPlayerAccuracy(player: PerformanceStats): string {
  const value = performanceStats(player).accuracy;
  const accuracy = nonNegativeNumber(value == null ? null : String(value).replace(/%$/, ""));
  return accuracy === null ? "—" : `${accuracy.toFixed(2)}%`;
}

export function formatPlayerPace(player: PerformanceStats): string {
  return nonNegativeNumber(performanceStats(player).kpm)?.toFixed(2) ?? "—";
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function nonNegativeNumber(value: NumericValue): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function crouchesPerMatch(input: PerformanceStats): number | null {
  const player = performanceStats(input);
  const crouches = nonNegativeNumber(player.crouches);
  const matches = nonNegativeNumber(player.matches);
  if (crouches === null || matches === null || matches === 0) return null;
  return crouches / matches;
}

// Aggregate totals weight short, late-joined rounds by actual playing time.
export function crouchesPerMinute(input: PerformanceStats): number | null {
  const player = performanceStats(input);
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
