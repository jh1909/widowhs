import { performanceStats, type PerformanceStats } from "./profile-stats.ts";

export function playerKdr(player: PerformanceStats): number | null {
  const value = performanceStats(player).kdr;
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : null;
}

export function formatPlayerKdr(player: PerformanceStats): string {
  return playerKdr(player)?.toFixed(2) ?? "—";
}
