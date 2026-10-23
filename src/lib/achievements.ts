import { playerKdr } from "./player-kdr.ts";
import { crouchesPerMatch, crouchesPerMinute, performanceStats, type PerformanceStats } from "./profile-stats.ts";

type NumericValue = number | string | null | undefined;

export type PlayerAchievementStats = PerformanceStats & {
  score?: NumericValue;
  deaths?: NumericValue;
  kdr?: NumericValue;
  accuracy?: NumericValue;
  matches?: NumericValue;
  crouches?: NumericValue;
  time_in_lobby?: NumericValue;
  rank?: NumericValue;
  speedrunner_count?: NumericValue;
};

export type SpeedrunnerMatch = {
  score?: NumericValue;
  total_match_time?: NumericValue;
};

export type AchievementId = "slayer" | "sharpshooter" | "veteran" | "fitness" | "no-croucher" | "elite" | "speedrunner";
export type Achievement = { id: AchievementId; name: string; desc: string; tier?: 1 | 2 | 3; count?: number };

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
  const accuracy = Number(String(performanceStats(player).accuracy ?? "").replace(/%$/, ""));
  if (Number.isFinite(accuracy) && accuracy >= 40) {
    const tier = accuracy >= 60 ? 3 : accuracy >= 50 ? 2 : 1;
    const numeral = ["I", "II", "III"][tier - 1];
    badges.push({ id: "sharpshooter", tier, name: `Sharpshooter ${numeral}`, desc: `Accuracy of ${30 + tier * 10}% or higher` });
  }
  if (numberOrZero(player.matches) >= 100) {
    badges.push({ id: "veteran", name: "Veteran", desc: "Played 100+ matches" });
  }
  if ((crouchesPerMatch(player) ?? 0) >= 100) {
    badges.push({ id: "fitness", name: "Squat Master", desc: "Average of 100+ crouches per match" });
  }
  const crouchRate = crouchesPerMinute(player);
  if (numberOrZero(performanceStats(player).matches) >= 1 && crouchRate !== null && crouchRate <= 0.1) {
    badges.push({ id: "no-croucher", name: "No Croucher", desc: "Average of 0.1 crouches/min or less" });
  }
  const rank = numberOrZero(player.rank);
  if (rank >= 1 && rank <= 10) {
    badges.push({ id: "elite", name: "Top 10", desc: "Currently in the global top 10" });
  }
  const count = player.speedrunner_count == null
    ? (isSpeedrunnerMatch(speedrunnerMatch) ? 1 : 0) : Math.floor(numberOrZero(player.speedrunner_count));
  if (count > 0) {
    badges.push({ id: "speedrunner", name: "Speedrunner", count, desc: "50-kill wins in under 3 minutes · Lifetime" });
  }
  return badges;
}
