import { isQualified, type PlacementPlayer } from '../../supabase/functions/_shared/elo-weight';
import { numericElo } from '../../supabase/functions/_shared/leaderboard';
import { playerKdr } from './player-kdr';
import { crouchesPerMinute } from './profile-stats';

type NumericValue = number | string | null;
export const medalCategories = ['kdr', 'accuracy', 'crouches', 'pace'] as const;
export type MedalCategory = typeof medalCategories[number];
export type MedalTier = 'gold' | 'silver' | 'bronze';
export type StatMedalPlayer = PlacementPlayer & {
  name: string; elo: NumericValue; kdr?: NumericValue; accuracy?: NumericValue;
  kpm?: NumericValue; crouches?: NumericValue; time_in_lobby?: NumericValue;
};
export const medalLabels: Record<MedalCategory, string> = {
  kdr: 'K/D', accuracy: 'Accuracy', crouches: 'Crouches/min', pace: 'Pace (KPM)',
};

function numericStat(value: NumericValue | undefined, percentage = false): number | null {
  if (value == null) return null;
  let text = String(value).trim();
  if (percentage) text = text.replace(/%$/, '').trim();
  if (!text) return null;
  const result = Number(text);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

// Compare displayed precision so identical visible values share a medal.
export function medalValue(player: StatMedalPlayer, category: MedalCategory): number | null {
  const value = category === 'kdr' ? playerKdr(player)
    : category === 'accuracy' ? numericStat(player.accuracy, true)
    : category === 'pace' ? numericStat(player.kpm)
    : crouchesPerMinute(player);
  return value === null ? null : Number(value.toFixed(category === 'crouches' ? 1 : 2));
}

export function formatMedalValue(player: StatMedalPlayer, category: MedalCategory): string {
  const value = medalValue(player, category);
  if (value === null) return '—';
  return value.toFixed(category === 'crouches' ? 1 : 2) + (category === 'accuracy' ? '%' : '');
}

// Three highest distinct values among placed players. Equal values share a
// tier; no medal is awarded for missing/invalid/zero performance.
// Call with the complete leaderboard before applying search or pagination.
export function statMedals(players: StatMedalPlayer[]): Map<string, Partial<Record<MedalCategory, MedalTier>>> {
  const eligible = players.filter(player => isQualified(player) && numericElo(player.elo) !== null);
  const result = new Map<string, Partial<Record<MedalCategory, MedalTier>>>();
  const tiers: MedalTier[] = ['gold', 'silver', 'bronze'];
  for (const category of medalCategories) {
    const values = eligible.map(player => ({ player, value: medalValue(player, category) }))
      .filter((entry): entry is { player: StatMedalPlayer; value: number } => entry.value !== null && entry.value > 0);
    const leaders = [...new Set(values.map(entry => entry.value))].sort((a, b) => b - a).slice(0, 3);
    for (const { player, value } of values) {
      const index = leaders.indexOf(value);
      if (index < 0) continue;
      const medals = result.get(player.name) ?? {};
      medals[category] = tiers[index];
      result.set(player.name, medals);
    }
  }
  return result;
}
