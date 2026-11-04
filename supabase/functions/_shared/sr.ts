// Skill rating (SR), docs/briefs/01-skill-rating.md. This is the reference
// implementation: the database's plpgsql port must evaluate the same formulas
// in the same order. Participants are taken in the caller's order (the
// database's: first player_matches.id in the round), so a rename doesn't move
// anyone; pairs are (i, j) with i before j, and every sum runs in that order.

export type SrParticipant = {
  name: string;                  // profile name, one participant per profile
  kills: number;
  present: number;               // seconds present
  afk: number;                   // AFK seconds (v2), 0 for v1
  shots: number | null;          // v2 only
  intervals: [number, number][]; // round-relative [start, end]; v1: [[length - present, length]]
};
export type SrRound = { id: string; playedAt: string; length: number; winner: string | null; participants: SrParticipant[] };

export type SrLobbySize = {
  minPlayers: number;   // fewer concurrent eligible players contribute nothing
  minWeight: number;    // curve passes through this weight at minPlayers (not a clamped floor)
  fullPlayers: number;  // ceiling starts here
  fullWeight: number;   // ceiling on round weight
};
export type SrSettings = {
  shareCurve: "raw" | "logistic"; // pairwise result: kill share, or a logistic curve on the kill difference
  logisticScale: number;          // kills; the logistic curve's spread
  m: number;                      // full-weight pairwise games per round
  lobbySize?: SrLobbySize;        // absent only for replaying the original, size-neutral model
  rd0: number;                    // uncertainty of a new player
  rdMin: number;                  // floor on uncertainty
  surpriseCap: number | null;     // cap on |S - E| per pair; null disables
  start: "default" | "seed";      // seed: players in the frozen seed map start there
  startSr: number;
  seedUncertainty: number;
  minActiveSeconds: number;       // below this a participant is excluded
  minShotsPerMinute: number;      // effort floor for rows with shots; below it a participant is excluded
  fullRoundGraceSeconds: number;  // a round counts as full if active >= length - grace
  placementUncertainty: number;   // placed once uncertainty <= this
  cautiousFactor: number;         // cautious SR = sr - factor * uncertainty
};
// Mirrors rating_params (version, d, beta, settings jsonb).
export type SrParams = { version: number; d: number; beta: number; settings: SrSettings };

export type SrPlayer = { sr: number; uncertainty: number; ratedWeight: number; fullRounds: number; lastRatedAt: string | null };
export type SrState = Map<string, SrPlayer>;
export type SrSeed = ReadonlyMap<string, number>;

export type SrEvent = {
  name: string; weight: number; full: boolean;
  srBefore: number; srAfter: number; uncertaintyBefore: number; uncertaintyAfter: number;
  expectedShare: number; actualShare: number; performance: number;
};
export type SrPair = {
  a: string; b: string; weight: number; // weight includes the lobby-size scale
  shareA: number; expectedA: number; expectedB: number; surpriseA: number; surpriseB: number;
};
export type SrLobby = { roundId: string; players: number; meanSr: number; minSr: number; maxSr: number };
export type SrExclusion = { name: string; reason: "round_length" | "short" | "effort" };
export type SrRoundResult = { events: SrEvent[]; pairs: SrPair[]; lobby: SrLobby | null; excluded: SrExclusion[] };

// Code-point order, the same as Postgres COLLATE "C" on UTF-8 text.
export function compareNames(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function glickoQ(d: number): number { return Math.LN10 / d; }
export function glickoG(uncertainty: number, d: number): number {
  const q = glickoQ(d);
  return 1 / Math.sqrt(1 + 3 * q * q * uncertainty * uncertainty / (Math.PI * Math.PI));
}

// The uncertainty reached after `rounds` full-weight rounds at even odds
// (E = 0.5) against established opponents (uncertainty rdMin). Real rounds
// carry less information, so PLACEMENT_ROUNDS ideal rounds is calibrated by
// the backtest to place a typical player after about 10 rated rounds.
export const PLACEMENT_ROUNDS = 6;
export function derivePlacementUncertainty(p: Pick<SrParams, "d"> & { settings: Pick<SrSettings, "m" | "rd0" | "rdMin"> }, rounds = PLACEMENT_ROUNDS): number {
  const q = glickoQ(p.d), g = glickoG(p.settings.rdMin, p.d);
  let rd = p.settings.rd0;
  for (let i = 0; i < rounds; i++) {
    const inv = 1 / (rd * rd) + q * q * p.settings.m * g * g * 0.25;
    rd = Math.max(p.settings.rdMin, Math.sqrt(1 / inv));
  }
  return rd;
}

// Chosen by scripts/sr-backtest.ts (brief 01, "Backtest").
const baseSettings = {
  shareCurve: "raw", logisticScale: 10, m: 5, rd0: 160, rdMin: 50, surpriseCap: 0.25,
  lobbySize: { minPlayers: 2, minWeight: 0.05, fullPlayers: 8, fullWeight: 1 },
  start: "default", startSr: 1500, seedUncertainty: 150,
  minActiveSeconds: 30,
  // An active Widowmaker fires every few seconds; AFK time is already
  // subtracted, so under 2 shots per active minute means present but not
  // playing (walking about, spectating), never merely playing badly.
  minShotsPerMinute: 2,
  fullRoundGraceSeconds: 10, cautiousFactor: 2,
} as const;
export const DEFAULT_SR_PARAMS: SrParams = {
  version: 2, d: 400, beta: 0.05,
  settings: { ...baseSettings, placementUncertainty: derivePlacementUncertainty({ d: 400, settings: baseSettings }) },
};

// The exponent is derived from both endpoints, so moving either endpoint
// changes one smooth power curve rather than clipping it to a minimum weight.
export function lobbySizeWeight(players: number, curve?: SrLobbySize): number {
  if (curve === undefined) return players < 2 ? 0 : 1;
  if (!curve || !Number.isInteger(curve.minPlayers) || curve.minPlayers < 2 ||
      !Number.isInteger(curve.fullPlayers) || curve.fullPlayers <= curve.minPlayers ||
      !Number.isFinite(curve.minWeight) || !Number.isFinite(curve.fullWeight) ||
      curve.minWeight <= 0 || curve.minWeight > curve.fullWeight || curve.fullWeight > 1) {
    throw new Error("invalid_lobby_size");
  }
  if (players < curve.minPlayers) return 0;
  if (players >= curve.fullPlayers) return curve.fullWeight;
  const exponent = Math.log(curve.minWeight / curve.fullWeight) /
    Math.log((curve.minPlayers - 1) / (curve.fullPlayers - 1));
  return curve.fullWeight * Math.pow((players - 1) / (curve.fullPlayers - 1), exponent);
}

export function cautiousSr(player: SrPlayer, params: SrParams): number {
  return player.sr - params.settings.cautiousFactor * player.uncertainty;
}
export function isPlaced(player: SrPlayer, params: SrParams): boolean {
  return player.uncertainty <= params.settings.placementUncertainty;
}

export function startingPlayer(name: string, params: SrParams, seed?: SrSeed): SrPlayer {
  const s = params.settings;
  if (s.start === "seed") {
    if (!seed) throw new Error("seed_required");
    const sr = seed.get(name);
    if (sr !== undefined) return { sr, uncertainty: s.seedUncertainty, ratedWeight: 0, fullRounds: 0, lastRatedAt: null };
  }
  return { sr: s.startSr, uncertainty: s.rd0, ratedWeight: 0, fullRounds: 0, lastRatedAt: null };
}

// Brief 02 grows uncertainty with inactivity here; 01 leaves it unchanged.
export function preRoundUncertainty(player: SrPlayer, _playedAt: string, _params: SrParams): number {
  return player.uncertainty;
}

// Sorted, merged, non-empty intervals.
export function normaliseIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([s, e]) => e > s).map(([s, e]) => [s, e] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function overlap(x: [number, number][], y: [number, number][]): number {
  let total = 0;
  for (const [xs, xe] of x) for (const [ys, ye] of y) total += Math.max(0, Math.min(xe, ye) - Math.max(xs, ys));
  return total;
}

type Entry = {
  name: string; kills: number; weight: number; active: number; intervals: [number, number][]; span: number;
  ratedWeight: number;
  sr: number; uncertainty: number; g: number;
  s1: number; s2: number; sw: number; ss: number; se: number; pairs: number;
};

// Rates one round against the pre-round state, without changing it.
//
// Lobby-level shares, for "expected 41% of the kills against this lobby,
// took 48%": the mean over the player's rated pairs, weighted by pair weight
// times g(opponent uncertainty), of the expected share E and of the result S
// (pro-rated, after the share curve and winner's bonus). Performance is
// actual minus expected; without the surprise cap its sign is the sign of
// the rating change.
export function rateRound(state: ReadonlyMap<string, SrPlayer>, round: SrRound, params: SrParams, seed?: SrSeed): SrRoundResult {
  const s = params.settings;
  lobbySizeWeight(2, s.lobbySize); // reject invalid settings even for empty rounds
  const ordered = round.participants;
  const names = new Set<string>();
  for (const p of ordered) {
    if (names.has(p.name)) throw new Error(`duplicate_participant:${p.name}`);
    names.add(p.name);
  }
  const excluded: SrExclusion[] = [];
  const empty = (): SrRoundResult => ({ events: [], pairs: [], lobby: null, excluded });
  if (!(round.length > 0)) {
    for (const p of ordered) excluded.push({ name: p.name, reason: "round_length" });
    return empty();
  }
  const entries: Entry[] = [];
  for (const p of ordered) {
    const active = Math.max(0, p.present - p.afk);
    if (active < s.minActiveSeconds) { excluded.push({ name: p.name, reason: "short" }); continue; }
    if (p.shots !== null && p.shots * 60 < s.minShotsPerMinute * active) { excluded.push({ name: p.name, reason: "effort" }); continue; }
    const intervals = normaliseIntervals(p.intervals);
    let span = 0;
    for (const [a, b] of intervals) span += b - a;
    const player = state.get(p.name) ?? startingPlayer(p.name, params, seed);
    const uncertainty = preRoundUncertainty(player, round.playedAt, params);
    entries.push({
      name: p.name, kills: p.kills, weight: Math.min(1, active / round.length), active, intervals, span,
      sr: player.sr, uncertainty, g: glickoG(uncertainty, params.d), ratedWeight: 0,
      s1: 0, s2: 0, sw: 0, ss: 0, se: 0, pairs: 0,
    });
  }
  if (entries.length < 2) return empty();

  const scale = s.m / (entries.length - 1);
  // Integrate the curve over concurrent sessions, not over the average size
  // or the total names in the round. Normalising each period separately also
  // keeps replacements from diluting a player's evidence. AFK timestamps are
  // unavailable: keep the existing pairwise active-time cap below.
  const pairWeights = entries.map(() => entries.map(() => 0));
  if (s.lobbySize !== undefined) {
    const boundaries = [...new Set([0, round.length, ...entries.flatMap(e => e.intervals.flat())])]
      .filter(t => t >= 0 && t <= round.length).sort((a, b) => a - b);
    for (let k = 1; k < boundaries.length; k++) {
      const start = boundaries[k - 1], end = boundaries[k];
      const present = entries.map((e, i) => e.intervals.some(([a, b]) => a <= start && b >= end) ? i : -1)
        .filter(i => i >= 0);
      const weight = lobbySizeWeight(present.length, s.lobbySize);
      if (weight === 0) continue;
      const duration = (end - start) / round.length;
      for (const i of present) entries[i].ratedWeight += duration * weight;
      for (let a = 0; a < present.length; a++) for (let b = a + 1; b < present.length; b++) {
        pairWeights[present[a]][present[b]] += duration * s.m * weight / (present.length - 1);
      }
    }
    for (const e of entries) e.ratedWeight *= Math.min(1, e.active / e.span);
  }
  const winner = entries.some((e) => e.name === round.winner) ? round.winner : null;
  const cap = (x: number) => s.surpriseCap === null ? x : Math.max(-s.surpriseCap, Math.min(s.surpriseCap, x));
  const pairs: SrPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const shared = overlap(a.intervals, b.intervals);
      if (shared <= 0) continue;
      // Each player's kills pro-rated to the time both were present.
      const ka = a.kills * shared / a.span, kb = b.kills * shared / b.span;
      if (ka + kb <= 0) continue;
      let shareA = s.shareCurve === "raw" ? ka / (ka + kb) : 1 / (1 + Math.exp(-(ka - kb) / s.logisticScale));
      if (winner === a.name) shareA = shareA + params.beta * (1 - shareA);
      else if (winner === b.name) shareA = 1 - ((1 - shareA) + params.beta * shareA);
      const shareB = 1 - shareA;
      const weight = s.lobbySize === undefined
        ? Math.min(shared / round.length, a.weight, b.weight) * scale
        : pairWeights[i][j] * Math.min(1, a.active / shared, b.active / shared);
      if (weight <= 0) continue;
      const expectedA = 1 / (1 + Math.pow(10, -b.g * (a.sr - b.sr) / params.d));
      const expectedB = 1 / (1 + Math.pow(10, -a.g * (b.sr - a.sr) / params.d));
      const surpriseA = cap(shareA - expectedA), surpriseB = cap(shareB - expectedB);
      for (const [x, gy, share, expected, surprise] of [
        [a, b.g, shareA, expectedA, surpriseA], [b, a.g, shareB, expectedB, surpriseB],
      ] as const) {
        const w = weight * gy;
        x.s1 += w * surprise;
        x.s2 += w * gy * expected * (1 - expected);
        x.sw += w;
        x.ss += w * share;
        x.se += w * expected;
        x.pairs += 1;
      }
      pairs.push({ a: a.name, b: b.name, weight, shareA, expectedA, expectedB, surpriseA, surpriseB });
    }
  }

  const q = glickoQ(params.d);
  const events: SrEvent[] = [];
  for (const e of entries) {
    if (e.pairs === 0) continue;
    const inv = 1 / (e.uncertainty * e.uncertainty) + q * q * e.s2;
    const actualShare = e.ss / e.sw, expectedShare = e.se / e.sw;
    events.push({
      name: e.name, weight: s.lobbySize === undefined ? e.weight : e.ratedWeight,
      full: round.length - e.active <= s.fullRoundGraceSeconds,
      srBefore: e.sr, srAfter: e.sr + q / inv * e.s1,
      uncertaintyBefore: e.uncertainty, uncertaintyAfter: Math.max(s.rdMin, Math.sqrt(1 / inv)),
      expectedShare, actualShare, performance: actualShare - expectedShare,
    });
  }

  let weightSum = 0, weighted = 0, minSr = Infinity, maxSr = -Infinity;
  for (const e of entries) {
    weightSum += e.weight;
    weighted += e.weight * e.sr;
    minSr = Math.min(minSr, e.sr);
    maxSr = Math.max(maxSr, e.sr);
  }
  const lobby = { roundId: round.id, players: entries.length, meanSr: weighted / weightSum, minSr, maxSr };
  return { events, pairs, lobby, excluded };
}

// Writes a round's events into the state. Players without an event are untouched.
export function applyRound(state: SrState, round: SrRound, result: SrRoundResult): void {
  for (const e of result.events) {
    const before = state.get(e.name);
    state.set(e.name, {
      sr: e.srAfter, uncertainty: e.uncertaintyAfter,
      ratedWeight: (before?.ratedWeight ?? 0) + e.weight,
      fullRounds: (before?.fullRounds ?? 0) + (e.full ? 1 : 0),
      lastRatedAt: round.playedAt,
    });
  }
}

// Microseconds since the epoch, as Postgres stores timestamptz (Date.parse
// keeps only milliseconds). A time without an offset is UTC.
export function timeKey(ts: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/i.exec(ts.trim());
  if (!m) throw new Error(`invalid_time:${ts}`);
  let offset = 0;
  if (m[8] && m[8].toUpperCase() !== "Z") {
    const digits = m[8].replace(":", "");
    offset = (digits[0] === "-" ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0));
  }
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offset * 60_000;
  return ms * 1000 + Number((m[7] ?? "").padEnd(6, "0"));
}

// Round order: played_at to the microsecond, then id in code-point order.
export function compareRounds(a: Pick<SrRound, "playedAt" | "id">, b: Pick<SrRound, "playedAt" | "id">): number {
  return timeKey(a.playedAt) - timeKey(b.playedAt) || compareNames(a.id, b.id);
}

export function replay(rounds: SrRound[], params: SrParams, seed?: SrSeed): { state: SrState; results: SrRoundResult[] } {
  const state: SrState = new Map();
  const results: SrRoundResult[] = [];
  for (const round of rounds.slice().sort(compareRounds)) {
    const result = rateRound(state, round, params, seed);
    applyRound(state, round, result);
    results.push(result);
  }
  return { state, results };
}
