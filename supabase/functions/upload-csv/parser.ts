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
  // v2 logs only; v1 rows leave these unset.
  sessions?: number;
  status?: SessionStatus;
  shots?: number;
  hits?: number;
  afk_seconds?: number;
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

// v2 logs (docs/workshop-log-format.md) start with a `#V` line and carry one
// `#P` line per player session plus `#K` kill codes. Files without it are v1.
export type SessionStatus = "present" | "left" | "kicked";
export interface LogSession {
  session_no: number; logged_name: string; slot: number; start_s: number; end_s: number;
  status: SessionStatus; kills: number; deaths: number; shots: number; hits: number;
  crouches: number; afk_seconds: number;
}
export interface KillPair { killer_session_no: number; victim_session_no: number; kills: number }
export interface LogRound {
  script_version: string; round_length: number; winner_name: string;
  sessions: LogSession[]; kill_pairs: KillPair[];
}

const statuses: SessionStatus[] = ["present", "left", "kicked"];

export function isV2Log(rows: string[][]): boolean {
  return rows[0]?.[0]?.trim() === "#V";
}

export function parseV2Rows(rows: string[][]): LogRound {
  let round: Pick<LogRound, "round_length" | "winner_name"> | null = null;
  const sessions = new Map<number, LogSession>();
  const codes: { code: number; record: number }[] = [];
  rows.forEach((raw, index) => {
    const record = index + 1;
    const row = raw.map((value) => value.trim());
    const fail = (message: string): never => { throw new Error(`Record ${record}: ${message}`); };
    const number = (column: number, integer = false) => {
      const value = Number(row[column]);
      if (!row[column] || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        fail(`invalid ${integer ? "whole " : ""}number in column ${column + 1}.`);
      }
      return value;
    };
    const fields = (count: number) => {
      if (row.length !== count) fail(`expected ${count} columns for ${row[0]}.`);
    };
    switch (row[0]) {
      case "#V":
        if (index !== 0) fail("#V must be the first line.");
        fields(3);
        if (row[1] !== "2") fail(`unsupported log version ${row[1]}.`);
        if (!row[2]) fail("missing script version.");
        break;
      case "#R":
        if (round) fail("more than one #R line.");
        fields(3);
        round = { round_length: number(1), winner_name: row[2] };
        break;
      case "#P": {
        fields(13);
        const session_no = number(1, true);
        if (session_no < 1) fail("session numbers start at 1.");
        if (sessions.has(session_no)) fail(`session ${session_no} appears twice.`);
        if (!row[2]) fail("missing player name.");
        const status = statuses[number(6, true)] ?? fail("status must be 0, 1 or 2.");
        const session: LogSession = {
          session_no, logged_name: row[2], slot: number(3, true), start_s: number(4), end_s: number(5), status,
          kills: number(7, true), deaths: number(8, true), shots: number(9, true), hits: number(10, true),
          crouches: number(11, true), afk_seconds: number(12),
        };
        if (session.end_s < session.start_s) fail("session ends before it starts.");
        sessions.set(session_no, session);
        break;
      }
      case "#K":
        // `0` pads the last line to a full set of codes.
        row.slice(1).forEach((_, column) => {
          const code = number(column + 1, true);
          if (code) codes.push({ code, record });
        });
        break;
      default:
        fail(`unexpected line ${row[0] || "(empty)"} in a v2 log.`);
    }
  });
  if (!round) throw new Error("Missing #R line.");
  if (!sessions.size) throw new Error("No match records found.");
  // Each code is killer session × 100 + victim session; count the pairs.
  const pairs = new Map<string, KillPair>();
  for (const { code, record } of codes) {
    const killer = Math.floor(code / 100);
    const victim = code % 100;
    if (!sessions.has(killer) || !sessions.has(victim)) {
      throw new Error(`Record ${record}: kill code ${code} names an unknown session.`);
    }
    if (killer === victim) continue;
    const key = `${killer}:${victim}`;
    const pair = pairs.get(key) ?? { killer_session_no: killer, victim_session_no: victim, kills: 0 };
    pair.kills++;
    pairs.set(key, pair);
  }
  const { round_length, winner_name } = round as Pick<LogRound, "round_length" | "winner_name">;
  return {
    script_version: rows[0][2].trim(), round_length, winner_name,
    sessions: [...sessions.values()], kill_pairs: [...pairs.values()],
  };
}
