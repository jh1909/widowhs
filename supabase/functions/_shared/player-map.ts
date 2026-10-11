type TrackedPlayer = {
  name: string;
  bnet_accounts?: string[] | null;
  previous_names?: string[] | null;
};

export function createPlayerMap<T extends TrackedPlayer>(players: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const player of players) {
    for (const name of [player.name, ...(player.bnet_accounts ?? []), ...(player.previous_names ?? [])]) {
      const key = name.trim().toLowerCase();
      if (!key) continue;
      const existing = map.get(key);
      if (existing && existing.name !== player.name) {
        throw new Error(`Name ${name} is linked to multiple profiles. Please resolve the account links before importing.`);
      }
      map.set(key, player);
    }
  }
  return map;
}
