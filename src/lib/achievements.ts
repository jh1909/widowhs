import { playerKdr } from "./player-kdr.ts";
import { crouchesPerMatch } from "./profile-stats.ts";

type NumericValue = number | string | null | undefined;

export type PlayerAchievementStats = {
  score?: NumericValue;
  deaths?: NumericValue;
  kdr?: NumericValue;
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

export function isSpeedrunnerMatch(match: SpeedrunnerMatch | null | undefined): boolean {
  if (!match) return false;
  const duration = numberOrZero(match.total_match_time);
  return numberOrZero(match.score) >= 50 && duration > 0 && duration < 180;
}

export function getAchievements(player: PlayerAchievementStats, speedrunnerMatch?: SpeedrunnerMatch | null): Achievement[] {
  const badges: Achievement[] = [];
  if ((playerKdr(player) ?? 0) > 2) {
    badges.push({ id: "slayer", name: "Slayer", desc: "Current K/D above 2.0" });
  }
  const accuracy = Number(String(player.accuracy ?? "").replace(/%$/, ""));
  if (Number.isFinite(accuracy) && accuracy > 40) {
    badges.push({ id: "sharpshooter", name: "Sharpshooter", desc: "Accuracy over 40%" });
  }
  if (numberOrZero(player.matches) >= 100) {
    badges.push({ id: "veteran", name: "Veteran", desc: "Played 100+ matches" });
  }
  if ((crouchesPerMatch(player) ?? 0) >= 100) {
    badges.push({ id: "fitness", name: "Squat Master", desc: "Average of 100+ crouches per match" });
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
