export function calculateRating(stats: { kpm: number; accuracy: number; kdr: number }): number {
  const pace = Math.min(stats.kpm / 16.67, 1.67);
  const accuracy = Math.min(stats.accuracy / 60, 1.15);
  const kdr = Math.min(stats.kdr, 4.0) / 3.0;
  return Math.round((pace * 0.65 + accuracy * 0.25 + kdr * 0.10) * 1000);
}
