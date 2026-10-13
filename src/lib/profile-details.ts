export const BIO_LIMIT = 500;
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
export type SetupKey = typeof setupFields[number]['key'];
export type ProfileDetails = { bio: string; setup: Partial<Record<SetupKey, string>> };
export const emptyProfileDetails = (): ProfileDetails => ({ bio: '', setup: {} });
