export const regions = [
  { value: 'eu', short: 'EU', name: 'Europe' },
  { value: 'na', short: 'NA', name: 'North America' },
] as const;
export type Region = typeof regions[number]['value'];

// Anything other than a known region code means "all regions".
export const parseRegion = (value: unknown): Region | null =>
  regions.find(region => region.value === value)?.value ?? null;
export const regionInfo = (value: Region | null) => regions.find(region => region.value === value) ?? null;
