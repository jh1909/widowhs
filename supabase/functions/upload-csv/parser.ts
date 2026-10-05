export interface MatchData {
  player_name: string;
  score: number;
  deaths: number;
  accuracy: number;
  kpm: number;
  kdr: number;
  crouches: number;
  time_in_lobby: number;
  total_match_time: number | null;
}

// Workshop logs may contain one record per line or several timestamped records
// on the same line. Plain CSV records keep their existing line breaks.
export function normalizeMatchLog(text: string): string {
  return text.replace(/^\uFEFF/, "")
    .replace(/(?:^|\s+)\[\d{2}:\d{2}:\d{2}\][ \t]*/g, "\n")
    .trim();
}

export function parseMatchRows(rows: string[][]): MatchData[] {
  const matches: MatchData[] = [];
  rows.forEach((row, index) => {
    const name = row[0]?.trim();
    if (!name || name === "Unknown") return;
    if (/^player([_ ]name)?$/i.test(name) && !Number.isFinite(Number(row[1]))) return;
    if (row.length !== 8 && row.length !== 9) {
      throw new Error(`Record ${index + 1}: expected 8 or 9 columns.`);
    }
    const values = row.slice(1).map((value, column) => {
      const number = Number(value.trim());
      if (!value.trim() || !Number.isFinite(number) || number < 0) {
        throw new Error(`Record ${index + 1}: invalid number in column ${column + 2}.`);
      }
      return number;
    });
    const [score, deaths, accuracy, kpm, kdr, crouches, time_in_lobby] = values;
    const total_match_time = values[7] ?? null;
    if (total_match_time !== null && !Number.isInteger(total_match_time)) {
      throw new Error(`Record ${index + 1}: total match time must be whole seconds.`);
    }
    matches.push({ player_name: name, score, deaths, accuracy, kpm, kdr,
      crouches, time_in_lobby, total_match_time });
  });
  return matches;
}
