import { isV2Log, parseMatchRows, parseV2Rows, type KillPair, type LogRound, type LogSession, type MatchData }
  from "../upload-csv/parser.ts";

export type MatchSource = { name: string; text: string; played_at: string | null; host_name: string | null };
export type SessionMatch = MatchData & { session_rows?: LogSession[] };
export type PreparedRound = {
  name: string;
  raw_log: {
    sha256: string; filename: string | null; host_name: string | null; format_version: 1 | 2 | 3;
    script_version: string | null; match_id: string; round_length: number | null; winner_name: string | null; text: string;
  };
  matches: (SessionMatch & { played_at: string | null; match_id: string })[];
  kill_pairs: (KillPair & { match_id: string })[];
};

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// Sessions with the same name that do not overlap are one player who left and
// rejoined: they become one participation. Overlapping sessions are two players
// sharing a name; they stay separate participations, as v1 rows did, until
// identity (brief 06) resolves them.
export function mergeSessions(round: LogRound): SessionMatch[] {
  const groups: LogSession[][] = [];
  const open = new Map<string, LogSession[][]>();
  for (const session of [...round.sessions].sort((a, b) => a.start_s - b.start_s || a.session_no - b.session_no)) {
    const key = session.logged_name.toLowerCase();
    const candidates = open.get(key) ?? [];
    let group = candidates.find((sessions) => sessions[sessions.length - 1].end_s <= session.start_s);
    if (!group) {
      group = [];
      candidates.push(group);
      groups.push(group);
      open.set(key, candidates);
    }
    group.push(session);
  }
  return groups.map((sessions) => {
    const sum = (field: "kills" | "deaths" | "shots" | "hits" | "crouches" | "afk_seconds") =>
      sessions.reduce((total, session) => total + session[field], 0);
    const time = sessions.reduce((total, session) => total + session.end_s - session.start_s, 0);
    const score = sum("kills");
    const deaths = sum("deaths");
    const shots = sum("shots");
    const hits = sum("hits");
    // Kills per minute counts active minutes only, so AFK time doesn't lower it.
    const active = Math.max(0, time - sum("afk_seconds"));
    // Otherwise the same derivations the Workshop used for v1 rows.
    return {
      player_name: sessions[0].logged_name, score, deaths,
      accuracy: shots ? round2(hits / shots * 100) : 0,
      kpm: active ? round2(score / (active / 60)) : 0,
      kdr: round2(score / Math.max(deaths, 1)),
      crouches: sum("crouches"), time_in_lobby: Math.floor(time),
      total_match_time: Math.floor(round.round_length),
      sessions: sessions.length, status: sessions[sessions.length - 1].status, shots, hits,
      afk_seconds: round2(sum("afk_seconds")), session_rows: sessions,
    };
  });
}

// One file is one round: parse it as v1 or v2 and give it a new round id.
export async function prepareRound(source: MatchSource, rows: string[][]): Promise<PreparedRound> {
  const match_id = crypto.randomUUID();
  const v2 = isV2Log(rows) ? parseV2Rows(rows) : null;
  const matches = v2 ? mergeSessions(v2) : parseMatchRows(rows);
  if (!matches.length) throw new Error("No match records found.");
  return {
    name: source.name,
    raw_log: {
      sha256: await sha256Hex(source.text), filename: source.name, host_name: source.host_name,
      format_version: v2?.format_version ?? 1, script_version: v2?.script_version ?? null, match_id,
      round_length: v2?.round_length ?? null, winner_name: v2?.winner_name || null, text: source.text,
    },
    matches: matches.map((match) => ({ ...match, played_at: source.played_at, match_id })),
    kill_pairs: (v2?.kill_pairs ?? []).map((pair) => ({ ...pair, match_id })),
  };
}
