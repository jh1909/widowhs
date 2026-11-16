export const BIO_LIMIT = 500;

export const REGION_OPTIONS = [
  { value: 'EU', label: 'EU — Europe' },
  { value: 'NA', label: 'NA — North America' },
  { value: 'ASIA', label: 'ASIA — Asia' },
  { value: 'SA', label: 'SA — South America' },
  { value: 'OCE', label: 'OCE — Oceania' },
  { value: 'MENA', label: 'MENA — Middle East' },
] as const;

export const RANK_TIERS = [
  'Top 500',
  'Champion',
  'Grandmaster',
  'Master',
  'Diamond',
  'Platinum',
  'Gold',
  'Silver',
  'Bronze',
] as const;

export const RANK_DIVISIONS = ['1', '2', '3', '4', '5'] as const;

export const RANK_ROLES = [
  { value: 'DPS', label: 'DPS' },
  { value: 'Tank', label: 'Tank' },
  { value: 'Support', label: 'Support (Healer)' },
] as const;

export const RANK_SEASONS: readonly string[] = [
  ...Array.from({ length: 25 }, (_, i) => `OW2 S${25 - i}`),
  ...Array.from({ length: 36 }, (_, i) => `OW1 S${36 - i}`),
];

export const setupFields = [
  { key: 'mouse', label: 'Mouse', placeholder: 'Mouse model', limit: 120 },
  { key: 'mousepad', label: 'Mousepad', placeholder: 'Mousepad model', limit: 120 },
  { key: 'keyboard', label: 'Keyboard', placeholder: 'Keyboard model', limit: 120 },
  { key: 'monitor', label: 'Monitor', placeholder: 'Model · resolution · refresh rate', limit: 120 },
  { key: 'dpi', label: 'Mouse DPI', placeholder: 'e.g. 800', limit: 120 },
  { key: 'sensitivity', label: 'In-game sensitivity', placeholder: 'e.g. 4.5', limit: 120 },
  { key: 'scoped_sensitivity', label: 'Scoped sensitivity', placeholder: 'e.g. 38%', limit: 120 },
  { key: 'crosshair', label: 'Crosshair', placeholder: 'Your crosshair settings', limit: 500, multiline: true },
  { key: 'settings', label: 'Other settings', placeholder: 'Graphics, keybinds or other settings', limit: 1000, multiline: true },
] as const;

export type BioSetupKey =
  | 'region'
  | 'highest_rank'
  | 'highest_rank_division'
  | 'highest_rank_role'
  | 'highest_rank_season';
export type SetupKey = typeof setupFields[number]['key'] | BioSetupKey;
export type ProfileDetails = { bio: string; setup: Partial<Record<SetupKey, string>> };
export const emptyProfileDetails = (): ProfileDetails => ({ bio: '', setup: {} });

export function formatRegion(region?: string): string {
  if (!region) return '';
  return REGION_OPTIONS.find(option => option.value === region)?.label ?? region;
}

export function formatHighestRank(setup: Partial<Record<SetupKey, string>>): string {
  const rank = setup.highest_rank;
  if (!rank) return '';
  const tier = rank !== 'Top 500' && setup.highest_rank_division
    ? `${rank} ${setup.highest_rank_division}`
    : rank;
  const base = [tier, setup.highest_rank_role].filter(Boolean).join(' · ');
  return setup.highest_rank_season ? `${base} (${setup.highest_rank_season})` : base;
}
