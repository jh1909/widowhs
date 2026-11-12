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
  join_time?: number | null;
  end_time?: number | null;
  active_time?: number | null;
  round_winner?: string | null;
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

  // Pre-scan for global #R or fallback max end_time
  let globalRoundDuration: number | null = null;
  let globalRoundWinner: string | null = null;
  const rRows = rows.filter((r) => r[0]?.trim() === "#R");
  if (rRows.length === 1) {
    const rRow = rRows[0];
    const duration = Number(rRow[1]?.trim());
    if (Number.isFinite(duration) && duration >= 0) {
      globalRoundDuration = duration;
    }
    if (rRow[2]?.trim()) {
      globalRoundWinner = rRow[2].trim();
    }
  }

  let fallbackRoundDuration: number | null = null;
  const newFormatRows = rows.filter((r) => {
    const p = r[0]?.trim() === "#P" ? r.slice(1) : r;
    return p.length === 11 && Number.isFinite(Number(p[8]?.trim()));
  });
  if (newFormatRows.length > 0) {
    const endTimes = newFormatRows.map((r) => {
      const p = r[0]?.trim() === "#P" ? r.slice(1) : r;
      return Number(p[8]?.trim());
    }).filter((t) => Number.isFinite(t) && t >= 0);
    if (endTimes.length > 0) {
      const max = Math.max(...endTimes);
      if (Number.isInteger(max)) {
        fallbackRoundDuration = max;
      }
    }
  }

  let currentRoundDuration: number | null = null;
  let currentRoundWinner: string | null = null;

  rows.forEach((row, index) => {
    if (!row || row.length === 0 || row.every((c) => !c.trim())) return;

    const first = row[0]?.trim();

    // Check for #R metadata line
    if (first === "#R") {
      const durationStr = row[1]?.trim();
      const duration = Number(durationStr);
      if (!durationStr || !Number.isFinite(duration) || duration < 0 || !Number.isInteger(duration)) {
        throw new Error(`Record ${index + 1}: total match time must be whole seconds.`);
      }
      currentRoundDuration = duration;
      currentRoundWinner = row[2]?.trim() || null;
      return;
    }

    // Skip any other # tags that are not #P (such as #V, #K, #C, or comments)
    if (first.startsWith("#") && first !== "#P") {
      return;
    }

    const isTagged = first === "#P";
    const payload = isTagged ? row.slice(1) : row;
    const name = payload[0]?.trim();
    if (!name || name === "Unknown") return;
    if (/^(player([_ ]name)?|name)$/i.test(name) && !Number.isFinite(Number(payload[1]))) return;

    if (payload.length !== 8 && payload.length !== 9 && payload.length !== 11) {
      throw new Error(`Record ${index + 1}: expected 8 or 9 columns.`);
    }

    const colOffset = isTagged ? 3 : 2;
    const values = payload.slice(1).map((value, column) => {
      const number = Number(value.trim());
      if (!value.trim() || !Number.isFinite(number) || number < 0) {
        throw new Error(`Record ${index + 1}: invalid number in column ${column + colOffset}.`);
      }
      return number;
    });

    if (payload.length === 8 || payload.length === 9) {
      const [score, deaths, accuracy, kpm, kdr, crouches, time_in_lobby] = values;
      const total_match_time = values[7] ?? currentRoundDuration ?? globalRoundDuration ?? null;
      if (total_match_time !== null && !Number.isInteger(total_match_time)) {
        throw new Error(`Record ${index + 1}: total match time must be whole seconds.`);
      }
      matches.push({
        player_name: name,
        score,
        deaths,
        accuracy,
        kpm,
        kdr,
        crouches,
        time_in_lobby,
        total_match_time,
      });
      return;
    }

    // New format (11 columns in payload)
    const [score, deaths, accuracy, kpm, kdr, crouches, join_time, end_time, time_in_lobby, active_time] = values;
    let total_match_time = currentRoundDuration ?? globalRoundDuration ?? fallbackRoundDuration ?? null;
    if (total_match_time !== null && !Number.isInteger(total_match_time)) {
      throw new Error(`Record ${index + 1}: total match time must be whole seconds.`);
    }
    const winner = currentRoundWinner ?? globalRoundWinner ?? null;
    const matchData: MatchData = {
      player_name: name,
      score,
      deaths,
      accuracy,
      kpm,
      kdr,
      crouches,
      time_in_lobby,
      total_match_time,
      join_time,
      end_time,
      active_time,
    };
    if (winner) {
      matchData.round_winner = winner;
    }
    matches.push(matchData);
  });

  return matches;
}
