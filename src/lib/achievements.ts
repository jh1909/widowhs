type NumericValue = number | string | null | undefined;

export type PlayerAchievementStats = {
  score?: NumericValue;
  deaths?: NumericValue;
  accuracy?: NumericValue;
  matches?: NumericValue;
  crouches?: NumericValue;
  rank?: NumericValue;
};

export type SpeedrunnerMatch = {
  score?: NumericValue;
  total_match_time?: NumericValue;
};

export type AchievementId = "slayer" | "sharpshooter" | "veteran" | "fitness" | "elite" | "speedrunner";
export type Achievement = { id: AchievementId; name: string; desc: string };

function numberOrZero(value: NumericValue): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

// Use the same total K/D and precision in the stat card and Slayer condition.
export function totalKdr(player: PlayerAchievementStats): number {
  const kills = numberOrZero(player.score);
  const deaths = numberOrZero(player.deaths);
  return Number((deaths > 0 ? kills / deaths : kills).toFixed(2));
}

export function isSpeedrunnerMatch(match: SpeedrunnerMatch | null | undefined): boolean {
  if (!match) return false;
  const duration = numberOrZero(match.total_match_time);
  return numberOrZero(match.score) >= 50 && duration > 0 && duration < 180;
}

export function getAchievements(player: PlayerAchievementStats, speedrunnerMatch?: SpeedrunnerMatch | null): Achievement[] {
  const badges: Achievement[] = [];
  if (totalKdr(player) > 2) {
    badges.push({ id: "slayer", name: "Slayer", desc: "Current total K/D above 2.0" });
  }
  const accuracy = Number(String(player.accuracy ?? "").replace(/%$/, ""));
  if (Number.isFinite(accuracy) && accuracy > 40) {
    badges.push({ id: "sharpshooter", name: "Sharpshooter", desc: "Accuracy over 40%" });
  }
  if (numberOrZero(player.matches) >= 100) {
    badges.push({ id: "veteran", name: "Veteran", desc: "Played 100+ matches" });
  }
  if (numberOrZero(player.crouches) > 1000) {
    badges.push({ id: "fitness", name: "Squat Master", desc: "1,000+ tactical crouches" });
  }
  const rank = numberOrZero(player.rank);
  if (rank >= 1 && rank <= 10) {
    badges.push({ id: "elite", name: "Top 10", desc: "Currently in the global top 10" });
  }
  if (isSpeedrunnerMatch(speedrunnerMatch)) {
    badges.push({ id: "speedrunner", name: "Speedrunner", desc: "Won a round with 50 kills in under 3 minutes" });
  }
  return badges;
}
