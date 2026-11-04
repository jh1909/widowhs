import { compareRounds, normaliseIntervals, srParticipationExclusion, timeKey, type SrParams, type SrRound } from "../supabase/functions/_shared/sr.ts";
export type Row = Record<string, string | null>;
const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

export function meanConcurrentSize(round: SrRound, params: SrParams): number {
  const timed = params.settings.rollingEvidenceKills !== undefined && round.participants.some(p => p.scoreEvents !== undefined);
  const people = round.participants.filter(p => srParticipationExclusion(p, params.settings, timed) === null);
  const at = (time: number) => people.filter(p => p.intervals.some(([a, b]) => a <= time && time <= b)).length;
  let total = 0, denominator = 0;
  if (timed) {
    for (const p of people) for (const e of p.scoreEvents!) if (e.delta > 0) {
      const n = at(e.at); if (n >= 2) { total += n; denominator++; }
    }
  } else {
    const bounds = [...new Set(people.flatMap(p => p.intervals.flat()))].sort((a, b) => a - b);
    for (let i = 1; i < bounds.length; i++) {
      const n = at((bounds[i - 1] + bounds[i]) / 2), duration = bounds[i] - bounds[i - 1];
      if (n >= 2) { total += n * duration; denominator += duration; }
    }
  }
  return denominator ? total / denominator : 0;
}

// One round per match_id, as the database assembles v1 rounds:
// - time is the earliest played_at (ties by match_id);
// - rounds whose rows disagree on total_match_time are skipped (a malformed batch);
// - a row without a profile is re-pointed to the one profile whose linked
//   Battle.net name or previous name matches it case-insensitively, else
//   left out; banned players are left out;
// - length is the largest total_match_time, else the longest time_in_lobby (all rows);
// - a profile's duplicate rows are merged: kills summed, longest time kept,
//   time present capped at the length;
// - participants are ordered by their first player_matches.id;
// - the winner is the sole top scorer with at least 50 kills.
export type Extra = { perf: { name: string; score: number }[] };
type Assembly = { rounds: SrRound[]; extra: Map<string, Extra>; skipped: string[]; droppedRows: number; repointed: number; capped: number; merged: number };
const pgArray = (v: string | null): string[] => {
  if (!v || v === "{}") return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,{}]+)/g;
  for (let m; (m = re.exec(v.slice(1, -1))); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
};
export function aliasMap(players: Row[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const p of players) {
    for (const alias of [...pgArray(p.bnet_accounts), ...pgArray(p.previous_names)]) {
      const key = alias.toLowerCase();
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(p.name!);
    }
  }
  return new Map([...owners].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0]]));
}
export function assembleRounds(matches: Row[], profiles: Set<string>, aliases: Map<string, string>, banned: Set<string>, logs: Row[], sessions: Row[]): Assembly {
  const raw = new Map(logs.map(r => [r.match_id!, r]));
  const sessionRows = new Map<string, Row[]>();
  for (const session of sessions) {
    const id = session.participation_id!;
    if (!sessionRows.has(id)) sessionRows.set(id, []);
    sessionRows.get(id)!.push(session);
  }
  const byMatch = new Map<string, Row[]>();
  for (const r of matches) {
    const id = r.match_id!;
    if (!byMatch.has(id)) byMatch.set(id, []);
    byMatch.get(id)!.push(r);
  }
  const out: Assembly = { rounds: [], extra: new Map(), skipped: [], droppedRows: 0, repointed: 0, capped: 0, merged: 0 };
  for (const [id, rows] of byMatch) {
    const totals = rows.map((r) => num(r.total_match_time)).filter((x): x is number => x !== null);
    const log = raw.get(id), structured = Number(log?.format_version) >= 2;
    if (!structured && new Set(totals).size > 1) { out.skipped.push(id); continue; }
    const playedAt = rows.map((r) => r.played_at!).sort((a, b) => timeKey(a) - timeKey(b))[0];
    const length = (structured ? num(log?.round_length) : null) ?? (totals.length ? Math.max(...totals) : Math.max(...rows.map((r) => num(r.time_in_lobby) ?? 0)));
    const named = rows.map((r) => {
      if (profiles.has(r.player_name!)) return r;
      const owner = aliases.get(r.player_name!.toLowerCase());
      if (owner) out.repointed += 1;
      return owner ? { ...r, player_name: owner } : r;
    });
    const kept = named.filter((r) => profiles.has(r.player_name!) && !banned.has(r.player_name!));
    out.droppedRows += rows.length - kept.length;
    const merged = new Map<string, { first: number; kills: number; present: number; afk: number; shots: number | null; sessions: Row[] }>();
    for (const r of kept) {
      const name = r.player_name!, rowId = Number(r.id);
      const kills = num(r.score) ?? 0, present = num(r.time_in_lobby) ?? 0;
      const m = merged.get(name);
      if (m) {
        out.merged += 1; m.kills += kills; m.present = Math.max(m.present, present); m.first = Math.min(m.first, rowId);
        m.afk += num(r.afk_seconds) ?? 0;
        if (r.shots != null) m.shots = (m.shots ?? 0) + Number(r.shots);
        m.sessions.push(...(sessionRows.get(r.id!) ?? []));
      } else merged.set(name, { first: rowId, kills, present, afk: num(r.afk_seconds) ?? 0,
        shots: num(r.shots), sessions: [...(sessionRows.get(r.id!) ?? [])] });
    }
    const participants = [...merged].sort((a, b) => a[1].first - b[1].first).map(([name, m]) => {
      if (m.present > length) out.capped += 1;
      const intervals = structured && m.sessions.length ? normaliseIntervals(m.sessions.map(s =>
        [Math.max(0, Number(s.start_s)), Math.min(length, Number(s.end_s))] as [number, number]))
        : [[length - Math.min(m.present, length), length]] as [number, number][];
      const present = intervals.reduce((sum, [a, b]) => sum + b - a, 0);
      let scoreEvents: SrRound['participants'][number]['scoreEvents'];
      if (Number(log?.format_version) === 3) {
        if (!m.sessions.length || m.sessions.some(s => s.score_events == null)) throw new Error(`Incomplete v3 histories in ${id}`);
        scoreEvents = m.sessions.sort((a, b) => Number(a.session_no) - Number(b.session_no)).flatMap(s => {
          let previous = 0;
          return (JSON.parse(s.score_events!) as { at_s: number; score: number }[]).map(e => {
            const delta = e.score - previous; previous = e.score;
            return { at: e.at_s, delta };
          });
        }).sort((a, b) => a.at - b.at);
      }
      return { name, kills: m.kills, present, afk: structured ? m.afk : 0, shots: structured ? m.shots : null,
        intervals, ...(scoreEvents === undefined ? {} : { scoreEvents }) };
    });
    if (!participants.length) continue;
    const top = Math.max(...participants.map((p) => p.kills));
    const leaders = participants.filter((p) => p.kills === top);
    const namedWinners = [...merged].filter(([, m]) => m.sessions.some(s => s.logged_name?.toLowerCase() === log?.winner_name?.trim().toLowerCase()));
    const winner = structured ? (namedWinners.length === 1 ? namedWinners[0][0] : null)
      : leaders.length === 1 && top >= 50 ? leaders[0].name : null;
    out.rounds.push({ id, playedAt, length, winner, participants });
    out.extra.set(id, { perf: kept.filter((r) => r.performance_score != null).map((r) => ({ name: r.player_name!, score: Number(r.performance_score) })) });
  }
  out.rounds.sort(compareRounds);
  return out;
}
