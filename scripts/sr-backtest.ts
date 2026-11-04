// Backtest of the skill rating (docs/briefs/01-skill-rating.md, "Backtest").
// Replays a production backup through supabase/functions/_shared/sr.ts and
// scores how well pre-round ratings predict each round's kill shares, against
// the formula ELO. Reads the backup with pg_restore; writes only to OUTDIR.
//
//   node --import tsx scripts/sr-backtest.ts DUMP OUTDIR [sweep | eval JSON | trace JSON NAME...]
//
// sweep: coarse grid, then local refinement, then the start variants, all
// judged on the tuning period; then one held-out evaluation. Writes sweep.tsv,
// heldout.tsv, report.txt, chosen.json and names.tsv (the report's P1, P2...).
// eval: one parameter set, a partial rating_params object over the
// prototype's settings, e.g. '{"d":300,"settings":{"m":12}}'. trace: round-by-round SR.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SR_PARAMS, PLACEMENT_ROUNDS, applyRound, cautiousSr, compareNames, compareRounds, derivePlacementUncertainty, isPlaced, rateRound, timeKey,
  type SrParams, type SrRound, type SrSeed, type SrState,
} from "../supabase/functions/_shared/sr.ts";

type Row = Record<string, string | null>;
function readTable(dump: string, table: string): Row[] {
  const out = spawnSync("pg_restore", ["--data-only", "-t", table, "-f", "-", dump], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(`pg_restore ${table}: ${out.stderr}`);
  const rows: Row[] = [];
  let cols: string[] | null = null;
  const unescape = (v: string) => v.replace(/\\(.)/g, (_, c) => ({ t: "\t", n: "\n", r: "\r", "\\": "\\" } as Record<string, string>)[c] ?? c);
  for (const line of out.stdout.split("\n")) {
    if (!cols) {
      if (line.startsWith("COPY ")) cols = line.slice(line.indexOf("(") + 1, line.indexOf(")")).split(", ");
      continue;
    }
    if (line === "\\.") break;
    const vals = line.split("\t");
    rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i] === "\\N" ? null : unescape(vals[i])])));
  }
  return rows;
}
const iso = (ts: string) => {
  let s = ts.replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  return new Date(Date.parse(s)).toISOString();
};
const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

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
type Extra = { perf: { name: string; score: number }[] };
type Assembly = { rounds: SrRound[]; extra: Map<string, Extra>; skipped: string[]; droppedRows: number; repointed: number; capped: number; merged: number };
const pgArray = (v: string | null): string[] => {
  if (!v || v === "{}") return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,{}]+)/g;
  for (let m; (m = re.exec(v.slice(1, -1))); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
};
function aliasMap(players: Row[]): Map<string, string> {
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
function assembleRounds(matches: Row[], profiles: Set<string>, aliases: Map<string, string>, banned: Set<string>): Assembly {
  const byMatch = new Map<string, Row[]>();
  for (const r of matches) {
    const id = r.match_id!;
    if (!byMatch.has(id)) byMatch.set(id, []);
    byMatch.get(id)!.push(r);
  }
  const out: Assembly = { rounds: [], extra: new Map(), skipped: [], droppedRows: 0, repointed: 0, capped: 0, merged: 0 };
  for (const [id, rows] of byMatch) {
    const totals = rows.map((r) => num(r.total_match_time)).filter((x): x is number => x !== null);
    if (new Set(totals).size > 1) { out.skipped.push(id); continue; }
    const playedAt = rows.map((r) => r.played_at!).sort((a, b) => timeKey(a) - timeKey(b))[0];
    const length = totals.length ? Math.max(...totals) : Math.max(...rows.map((r) => num(r.time_in_lobby) ?? 0));
    const named = rows.map((r) => {
      if (profiles.has(r.player_name!)) return r;
      const owner = aliases.get(r.player_name!.toLowerCase());
      if (owner) out.repointed += 1;
      return owner ? { ...r, player_name: owner } : r;
    });
    const kept = named.filter((r) => profiles.has(r.player_name!) && !banned.has(r.player_name!));
    out.droppedRows += rows.length - kept.length;
    const merged = new Map<string, { first: number; kills: number; present: number }>();
    for (const r of kept) {
      const name = r.player_name!, rowId = Number(r.id);
      const kills = num(r.score) ?? 0, present = num(r.time_in_lobby) ?? 0;
      const m = merged.get(name);
      if (m) { out.merged += 1; m.kills += kills; m.present = Math.max(m.present, present); m.first = Math.min(m.first, rowId); }
      else merged.set(name, { first: rowId, kills, present });
    }
    const participants = [...merged].sort((a, b) => a[1].first - b[1].first).map(([name, m]) => {
      if (m.present > length) out.capped += 1;
      const present = Math.min(m.present, length);
      return { name, kills: m.kills, present, afk: 0, shots: null, intervals: [[length - present, length]] as [number, number][] };
    });
    if (!participants.length) continue;
    const top = Math.max(...participants.map((p) => p.kills));
    const leaders = participants.filter((p) => p.kills === top);
    const winner = leaders.length === 1 && top >= 50 ? leaders[0].name : null;
    out.rounds.push({ id, playedAt, length, winner, participants });
    out.extra.set(id, { perf: kept.filter((r) => r.performance_score != null).map((r) => ({ name: r.player_name!, score: Number(r.performance_score) })) });
  }
  out.rounds.sort(compareRounds);
  return out;
}

// ---- evaluation ----

const ESTABLISHED = 10;    // a player is established after 10 earlier rated participations (setting-independent)
const BASELINE_MIN = 5;    // the formula baseline needs 5 earlier performance scores
const TUNE_SHARE = 0.7;
// Stability for selection is measured on the second half of the tuning
// period (the first half is warm-up, when nearly everyone is new).
const VALIDATION_SHARE = 0.35;

type PairSample = { r: number; y: number; w: number; x: number; e: number; base: number; up: number }; // up: +1/-1 kills order, 0 tie
type Snapshot = { day: string; cautious: Map<string, number>; activeMean: number; active: number };
type RunOut = {
  tune: PairSample[]; test: PairSample[];
  // Established players' rated rounds: in the validation slice of the tuning period, and in the test period.
  series: { val: Map<string, { idx: number; before: number; after: number }[]>; test: Map<string, { idx: number; before: number; after: number }[]> };
  snapshots: Snapshot[]; state: SrState; split: number;
  placedAfter: Map<string, number>; // rated rounds when first placed
};

type Data = { rounds: SrRound[]; extra: Map<string, Extra> };
function run(data: Data, params: SrParams, seed?: SrSeed, trace?: Map<string, string[]>): RunOut {
  const { rounds, extra } = data;
  const split = Math.floor(rounds.length * TUNE_SHARE);
  const state: SrState = new Map();
  const prior = new Map<string, number>();
  const hist = new Map<string, number[]>();
  const tune: PairSample[] = [], test: PairSample[] = [];
  const series: RunOut["series"] = { val: new Map(), test: new Map() };
  const valStart = Math.floor(rounds.length * VALIDATION_SHARE);
  const snapshots: Snapshot[] = [];
  const placedAfter = new Map<string, number>();
  let day = "";
  for (let idx = 0; idx < rounds.length; idx++) {
    const r = rounds[idx];
    const today = r.playedAt.slice(0, 10);
    if (today !== day) {
      if (day) {
        const cautious = new Map<string, number>();
        let sum = 0, active = 0;
        for (const [n, p] of state) {
          if (isPlaced(p, params)) cautious.set(n, cautiousSr(p, params));
          // Active: a rated round in the last 30 days (brief 02's drift monitor).
          if (p.lastRatedAt && timeKey(r.playedAt) - timeKey(p.lastRatedAt) <= 30 * 86400e6) { sum += p.sr; active += 1; }
        }
        snapshots.push({ day: today, cautious, activeMean: sum / active, active });
      }
      day = today;
    }
    const result = rateRound(state, r, params, seed);
    const by = new Map(r.participants.map((p) => [p.name, p]));
    const baseScore = (n: string) => {
      const h = hist.get(n) ?? [];
      if (h.length < BASELINE_MIN) return null;
      const last = h.slice(-100);
      return last.reduce((a, b) => a + b, 0) / last.length;
    };
    const into = idx < split ? tune : test;
    for (const pr of result.pairs) {
      if ((prior.get(pr.a) ?? 0) < ESTABLISHED || (prior.get(pr.b) ?? 0) < ESTABLISHED) continue;
      const ba = baseScore(pr.a), bb = baseScore(pr.b);
      if (ba === null || bb === null) continue;
      const a = by.get(pr.a)!, b = by.get(pr.b)!;
      const shared = Math.min(a.present, b.present);
      const ka = a.kills * shared / a.present, kb = b.kills * shared / b.present;
      into.push({
        r: idx, y: ka / (ka + kb), w: Math.min(shared / r.length, a.present / r.length, b.present / r.length, 1),
        x: Math.log(pr.expectedA / (1 - pr.expectedA)), e: pr.expectedA, base: ba - bb, up: Math.sign(ka - kb),
      });
    }
    if (idx >= valStart) {
      const into = idx < split ? series.val : series.test;
      for (const e of result.events) {
        if ((prior.get(e.name) ?? 0) < ESTABLISHED) continue;
        if (!into.has(e.name)) into.set(e.name, []);
        into.get(e.name)!.push({ idx, before: e.srBefore, after: e.srAfter });
      }
    }
    if (trace) {
      for (const e of result.events) {
        if (!trace.has(e.name)) continue;
        const p = by.get(e.name)!;
        const top = r.participants.map((q) => q.kills).sort((x, y) => y - x).slice(0, 3).join("/");
        trace.get(e.name)!.push([r.playedAt.slice(0, 16), p.kills + (r.winner === e.name ? "W" : ""), `${p.present}/${r.length}`, top,
          result.lobby!.players, result.lobby!.meanSr.toFixed(0), e.expectedShare.toFixed(3), e.actualShare.toFixed(3),
          `${e.srBefore.toFixed(0)}->${e.srAfter.toFixed(0)}`, `±${(2 * e.uncertaintyAfter).toFixed(0)}`].join("\t"));
      }
    }
    applyRound(state, r, result);
    for (const e of result.events) {
      if (!placedAfter.has(e.name) && isPlaced(state.get(e.name)!, params)) placedAfter.set(e.name, (prior.get(e.name) ?? 0) + 1);
    }
    for (const p of r.participants) {
      if (result.events.some((e) => e.name === p.name)) prior.set(p.name, (prior.get(p.name) ?? 0) + 1);
    }
    for (const p of extra.get(r.id)!.perf) {
      if (!hist.has(p.name)) hist.set(p.name, []);
      hist.get(p.name)!.push(p.score);
    }
  }
  return { tune, test, series, snapshots, state, split, placedAfter };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
function logLoss(samples: PairSample[], p: (s: PairSample) => number): number {
  let sum = 0, w = 0;
  for (const s of samples) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p(s)));
    sum += s.w * -(s.y * Math.log(q) + (1 - s.y) * Math.log(1 - q));
    w += s.w;
  }
  return sum / w;
}
function brier(samples: PairSample[], p: (s: PairSample) => number): number {
  let sum = 0, w = 0;
  for (const s of samples) { sum += s.w * (p(s) - s.y) ** 2; w += s.w; }
  return sum / w;
}
function accuracy(samples: PairSample[], x: (s: PairSample) => number): number {
  let hit = 0, n = 0;
  for (const s of samples) {
    if (s.up === 0) continue;
    n += 1;
    const d = x(s);
    hit += d === 0 ? 0.5 : Math.sign(d) === s.up ? 1 : 0;
  }
  return hit / n;
}
// Scale k minimising weighted log-loss of sigmoid(k * x), by golden section.
function fitScale(samples: PairSample[], x: (s: PairSample) => number): number {
  let lo = 0, hi = 0.5;
  while (logLoss(samples, (s) => sigmoid(hi * 2 * x(s))) < logLoss(samples, (s) => sigmoid(hi * x(s)))) hi *= 2;
  hi *= 2;
  const f = (k: number) => logLoss(samples, (s) => sigmoid(k * x(s)));
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo + (1 - phi) * (hi - lo), b = lo + phi * (hi - lo), fa = f(a), fb = f(b);
  for (let i = 0; i < 60; i++) {
    if (fa < fb) { hi = b; b = a; fb = fa; a = lo + (1 - phi) * (hi - lo); fa = f(a); }
    else { lo = a; a = b; fa = fb; b = lo + phi * (hi - lo); fb = f(b); }
  }
  return (lo + hi) / 2;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * q, f = Math.floor(i);
  return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (i - f);
};

type Stability = { range20Median: number; range20P90: number; drop8Median: number; drop8P90: number; drop8Max: number; weeklyCross: number; weeklyCrossShare: number; players: number };
function stability(out: RunOut, period: "val" | "test"): Stability {
  const ranges: number[] = [], drops: number[] = [];
  for (const s of out.series[period].values()) {
    if (s.length >= 20) {
      const last = s.slice(-20).map((x) => x.after);
      ranges.push(Math.max(...last) - Math.min(...last));
    }
    if (s.length >= 8) {
      let worst = -Infinity;
      for (let i = 0; i + 7 < s.length; i++) worst = Math.max(worst, s[i].before - s[i + 7].after);
      drops.push(worst);
    }
  }
  // 7-day windows ending in the period: placed players on both days who
  // changed side of the median cautious SR. Validation windows end before
  // the test period's first day.
  const inPeriod = (day: string) => period === "test" ? day >= testDay : day >= valDay && day < testDay;
  const crosses: number[] = [], shares: number[] = [];
  const side = (m: Map<string, number>) => {
    const med = quantile([...m.values()], 0.5);
    return (n: string) => m.get(n)! >= med;
  };
  for (let j = 7; j < out.snapshots.length; j++) {
    if (!inPeriod(out.snapshots[j].day)) continue;
    const a = out.snapshots[j - 7].cautious, b = out.snapshots[j].cautious;
    const sa = side(a), sb = side(b);
    let both = 0, flips = 0;
    for (const n of a.keys()) if (b.has(n)) { both += 1; if (sa(n) !== sb(n)) flips += 1; }
    crosses.push(flips); shares.push(both ? flips / both : 0);
  }
  return {
    range20Median: quantile(ranges, 0.5), range20P90: quantile(ranges, 0.9),
    drop8Median: quantile(drops, 0.5), drop8P90: quantile(drops, 0.9), drop8Max: Math.max(...drops),
    weeklyCross: quantile(crosses, 0.5), weeklyCrossShare: quantile(shares, 0.5), players: ranges.length,
  };
}
let testDay = "", valDay = "";

type Score = { logLossE: number; logLoss: number; brier: number; accuracy: number; k: number };
// stability: validation slice, the only one selection sees; held: test period, reported after the choice.
// test and held stay empty (NaN) until heldOut is asked for, after the choice.
type Evaluation = { label: string; params: SrParams; seed?: SrSeed; tune: Score; test: Score; stability: Stability; held: Stability; out: RunOut };
function score(out: RunOut, x: (s: PairSample) => number, rawE?: (s: PairSample) => number): { tune: Score; test: Score } {
  const k = fitScale(out.tune, x);
  const one = (samples: PairSample[]): Score => ({
    logLossE: rawE ? logLoss(samples, rawE) : NaN,
    logLoss: logLoss(samples, (s) => sigmoid(k * x(s))),
    brier: brier(samples, (s) => sigmoid(k * x(s))),
    accuracy: accuracy(samples, x), k,
  });
  return { tune: one(out.tune), test: one(out.test) };
}
const NO_SCORE: Score = { logLossE: NaN, logLoss: NaN, brier: NaN, accuracy: NaN, k: NaN };
const NO_STABILITY: Stability = { range20Median: NaN, range20P90: NaN, drop8Median: NaN, drop8P90: NaN, drop8Max: NaN, weeklyCross: NaN, weeklyCrossShare: NaN, players: 0 };
function evaluate(data: Data, label: string, params: SrParams, seed?: SrSeed, heldOut = false): Evaluation {
  const out = run(data, params, seed);
  const { tune, test } = score(out, (s) => s.x, (s) => s.e);
  if (!heldOut) out.test.length = 0;
  return { label, params, seed, tune, test: heldOut ? test : NO_SCORE, stability: stability(out, "val"), held: heldOut ? stability(out, "test") : NO_STABILITY, out };
}

// ---- parameters ----

type Patch = { d?: number; beta?: number; settings?: Partial<SrParams["settings"]> };
// The search starts from the prototype's settings, not the engine defaults,
// so its result doesn't depend on what it chose last time.
const PROTOTYPE = { d: 400, beta: 0.1, settings: { shareCurve: "raw", logisticScale: 10, m: 5, rd0: 350, rdMin: 50, surpriseCap: null, start: "default", seedUncertainty: 150 } } as const;
function makeParams(patch: Patch): SrParams {
  const settings = { ...DEFAULT_SR_PARAMS.settings, ...PROTOTYPE.settings, ...patch.settings };
  const p: SrParams = { ...DEFAULT_SR_PARAMS, d: patch.d ?? PROTOTYPE.d, beta: patch.beta ?? PROTOTYPE.beta, settings };
  p.settings.placementUncertainty = derivePlacementUncertainty(p);
  return p;
}
const describe = (p: SrParams) => {
  const s = p.settings;
  return `${s.shareCurve === "raw" ? "raw" : `logit${s.logisticScale}`} b=${p.beta} D=${p.d} m=${s.m} rd=${s.rd0}/${s.rdMin} cap=${s.surpriseCap ?? "none"} ${s.start}${s.start === "seed" ? `/${s.seedUncertainty}` : ""}`;
};

// Formula ELO at the start of the test period, from player_history snapshots
// taken before it, mapped linearly onto the SR scale (mean and spread of the
// default run's established ratings at the same moment).
function seedAtSplit(history: Row[], splitTime: string, scaleTo: Map<string, number>): Map<string, number> {
  const latest = new Map<string, { at: string; elo: number }>();
  for (const h of history) {
    const at = iso(h.created_at!);
    if (timeKey(h.created_at!) >= timeKey(splitTime) || h.elo == null) continue;
    const prev = latest.get(h.player_name!);
    if (!prev || at > prev.at) latest.set(h.player_name!, { at, elo: Number(h.elo) });
  }
  const common = [...latest.keys()].filter((n) => scaleTo.has(n));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
  const elo = common.map((n) => latest.get(n)!.elo), sr = common.map((n) => scaleTo.get(n)!);
  const slope = sd(sr) / sd(elo), me = mean(elo), ms = mean(sr);
  return new Map([...latest].map(([n, v]) => [n, ms + slope * (v.elo - me)]));
}

// ---- report helpers ----

const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const stabCols = (p: string) => ["range20_med", "range20_p90", "drop8_med", "drop8_p90", "drop8_max", "weekly_cross", "weekly_cross_share"].map((c) => `${p}_${c}`).join("\t");
const header = `label\tparams\ttune_ll\ttune_llE\ttune_acc\ttest_ll\ttest_llE\ttest_brier\ttest_acc\tk\t${stabCols("val")}\t${stabCols("test")}`;
const line = (e: Evaluation) => [e.label, describe(e.params), f(e.tune.logLoss), f(e.tune.logLossE), f(e.tune.accuracy), f(e.test.logLoss), f(e.test.logLossE),
  f(e.test.brier), f(e.test.accuracy), f(e.tune.k, 3), ...[e.stability, e.held].flatMap((st) => [f(st.range20Median, 1), f(st.range20P90, 1), f(st.drop8Median, 1),
  f(st.drop8P90, 1), f(st.drop8Max, 1), f(st.weeklyCross, 1), f(st.weeklyCrossShare, 3)])].join("\t");

function spearman(a: string[], b: string[]): number {
  const both = a.filter((n) => b.includes(n));
  const ra = new Map(a.filter((n) => both.includes(n)).map((n, i) => [n, i])), rb = new Map(b.filter((n) => both.includes(n)).map((n, i) => [n, i]));
  const n = both.length;
  return 1 - 6 * both.reduce((t, x) => t + (ra.get(x)! - rb.get(x)!) ** 2, 0) / (n * (n * n - 1));
}

// ---- main ----

const [dump, outDir, mode = "sweep", ...rest] = process.argv.slice(2);
if (!dump || !outDir) { console.error("usage: sr-backtest.ts DUMP OUTDIR [sweep | eval JSON | trace JSON NAME...]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const matches = readTable(dump, "player_matches");
const players = readTable(dump, "players");
const history = readTable(dump, "player_history");
const banned = new Set(players.filter((p) => p.is_banned === "t").map((p) => p.name!));
const data = assembleRounds(matches, new Set(players.map((p) => p.name!)), aliasMap(players), banned);
const split = Math.floor(data.rounds.length * TUNE_SHARE);
testDay = data.rounds[split].playedAt.slice(0, 10);
valDay = data.rounds[Math.floor(data.rounds.length * VALIDATION_SHARE)].playedAt.slice(0, 10);
const log: string[] = [];
const say = (s = "") => { console.log(s); log.push(s); };
say(`rounds ${data.rounds.length} (${data.rounds[0].playedAt.slice(0, 10)} to ${data.rounds.at(-1)!.playedAt.slice(0, 10)}); ` +
  `tuning ${split} rounds, test from ${data.rounds[split].playedAt} (${data.rounds.length - split} rounds); banned left out ${banned.size}`);
say(`assembly: skipped ${data.skipped.length} round(s) with conflicting lengths (${data.skipped.join(", ")}); re-pointed ${data.repointed} rows by alias, dropped ${data.droppedRows} rows without a profile; ` +
  `merged ${data.merged} duplicate rows; capped ${data.capped} times present at the round length`);

if (mode === "eval" || mode === "trace") {
  const params = makeParams(JSON.parse(rest[0] ?? "{}"));
  if (mode === "trace") {
    const trace = new Map(rest.slice(1).map((n) => [n, [] as string[]]));
    run(data, params, undefined, trace);
    for (const [n, rows] of trace) say(`== ${n}: time | kills | present/length | top 3 | players | lobby SR | expected | actual | SR | range\n${rows.join("\n")}`);
  } else {
    const e = evaluate(data, "eval", params);
    say(header); say(line(e));
  }
  writeFileSync(join(outDir, `${mode}.txt`), log.join("\n") + "\n");
  process.exit(0);
}

const all: Evaluation[] = [];
const seen = new Map<string, Evaluation>();
const tsv: string[] = [header];
function tryParams(label: string, patch: Patch, seed?: SrSeed): Evaluation {
  const p = makeParams(patch);
  const key = describe(p) + (seed ? "+seedmap" : "");
  const hit = seen.get(key);
  if (hit) return hit;
  const e = evaluate(data, label, p, seed);
  e.out.series.val.clear(); e.out.series.test.clear(); e.out.snapshots.length = 0; e.out.tune.length = 0; e.out.test.length = 0; e.out.state.clear(); // keep memory flat
  seen.set(key, e); all.push(e); tsv.push(line(e));
  return e;
}

// Baseline: the formula ELO as the mean of the previous <= 100 performance scores.
const reference = evaluate(data, "prototype M=5", makeParams({ beta: 0.1, settings: { m: 5, surpriseCap: null } }));
say(`established pairs in the tuning period: ${reference.out.tune.length}; stability validation from ${valDay}`);
const refStab = reference.stability;
tsv.push(line(reference));

// Choice: best tuning log-loss with beta >= 0.05 and stability no worse than
// the prototype setting (90th percentiles of the 20-round range and the
// 8-round drop, with 5% slack). Every stage searches around the best
// admissible settings, plus the best overall for exploration.
const stableEnough = (e: Evaluation) => e.stability.range20P90 <= refStab.range20P90 * 1.05 && e.stability.drop8P90 <= refStab.drop8P90 * 1.05;
const admissible = (e: Evaluation) => e.params.beta >= 0.05 && stableEnough(e);
const top = (xs: Evaluation[], n: number) => xs.slice().sort((a, b) => a.tune.logLoss - b.tune.logLoss).slice(0, n);
const union = (...xs: Evaluation[][]) => [...new Set(xs.flat())];
const patchOf = (e: Evaluation, settings: Partial<SrParams["settings"]> = {}, top: Patch = {}): Patch =>
  ({ d: top.d ?? e.params.d, beta: top.beta ?? e.params.beta, settings: { ...e.params.settings, ...settings } });

// 1. Coarse grid: curve x m x cap.
const curves: Partial<SrParams["settings"]>[] = [{ shareCurve: "raw" }, ...[5, 10, 20].map((s) => ({ shareCurve: "logistic" as const, logisticScale: s }))];
const stage1: Evaluation[] = [];
for (const c of curves) for (const m of [3, 5, 8, 12]) for (const cap of [null, 0.2, 0.25, 0.3]) {
  stage1.push(tryParams("grid", { beta: 0.1, settings: { ...c, m, surpriseCap: cap } }));
}
// 2. beta.
const stage2: Evaluation[] = [];
for (const e of union(top(stage1.filter(stableEnough), 3), top(stage1, 2))) {
  for (const beta of [0, 0.05, 0.1, 0.15, 0.2]) stage2.push(tryParams("beta", patchOf(e, {}, { beta })));
}
// 3. D and the uncertainty range.
for (const e of union(top(stage2.filter(admissible), 2), top(stage2.filter((x) => x.params.beta >= 0.05), 1))) {
  for (const d of [300, 400, 500]) for (const rd0 of [250, 350, 500]) for (const rdMin of [20, 30, 50, 70]) {
    tryParams("D/rd", patchOf(e, { rd0, rdMin }, { d }));
  }
}
// 4. Coordinate search around the best admissible setting.
const round5 = (x: number) => Math.max(5, Math.round(x / 5) * 5);
const halves = (x: number) => Math.max(0.5, Math.round(x * 2) / 2);
let current = top(all.filter(admissible), 1)[0] ?? reference;
for (let pass = 0; pass < 6; pass++) {
  const s = current.params.settings;
  const around: Evaluation[] = [current];
  for (const m of [s.m - 1, s.m + 1, s.m * 0.8, s.m * 1.25]) around.push(tryParams("refine", patchOf(current, { m: halves(m) })));
  for (const rdMin of [s.rdMin * 0.8, s.rdMin * 1.25]) around.push(tryParams("refine", patchOf(current, { rdMin: round5(rdMin) })));
  for (const rd0 of [s.rd0 * 0.8, s.rd0 * 1.25]) around.push(tryParams("refine", patchOf(current, { rd0: round5(rd0) })));
  for (const d of [current.params.d * 0.85, current.params.d * 1.15]) around.push(tryParams("refine", patchOf(current, {}, { d: Math.round(d / 10) * 10 })));
  for (const cap of [null, 0.2, 0.25, 0.3]) around.push(tryParams("refine", patchOf(current, { surpriseCap: cap })));
  for (const beta of [0.05, 0.1]) around.push(tryParams("refine", patchOf(current, {}, { beta })));
  if (s.shareCurve === "logistic") for (const sc of [s.logisticScale * 0.7, s.logisticScale * 1.4]) around.push(tryParams("refine", patchOf(current, { logisticScale: sc })));
  const next = top(around.filter(admissible), 1)[0];
  if (next === current) break;
  current = next;
}
writeFileSync(join(outDir, "sweep.tsv"), tsv.join("\n") + "\n");

// The brief makes the +/-0.25 cap a guard against freak rounds, which are
// too rare to show in log-loss: keep it unless dropping or changing it gains
// more than CAP_TOLERANCE on the tuning split.
const CAP_TOLERANCE = 0.0002;
const withBriefCap = tryParams("brief cap", patchOf(current, { surpriseCap: 0.25 }));
const chosenDefault = admissible(withBriefCap) && withBriefCap.tune.logLoss <= current.tune.logLoss + CAP_TOLERANCE ? withBriefCap : current;
const ranked = all.filter((e) => e.params.beta >= 0.05).sort((a, b) => a.tune.logLoss - b.tune.logLoss);
const bestUnconstrained = ranked[0];
say(`best by tuning log-loss (beta >= 0.05): ${describe(bestUnconstrained.params)} (tune ${f(bestUnconstrained.tune.logLoss)}); stable enough: ${stableEnough(bestUnconstrained)}`);
say(`best admissible: ${describe(current.params)} (tune ${f(current.tune.logLoss)}); with the brief's cap: ${f(withBriefCap.tune.logLoss)}`);
say(`chosen (default start): ${describe(chosenDefault.params)}; placement uncertainty ${f(chosenDefault.params.settings.placementUncertainty, 2)}`);

// 5. Start variants on the chosen settings, for the held-out comparison: the
// seed uses formula ELO snapshots from before the test period.
const splitTime = data.rounds[split].playedAt;
const atSplit = run({ rounds: data.rounds.slice(0, split), extra: data.extra }, chosenDefault.params);
const scaleTo = new Map([...atSplit.state].filter(([, p]) => isPlaced(p, chosenDefault.params)).map(([n, p]) => [n, p.sr]));
const seed = seedAtSplit(history, splitTime, scaleTo);
const starts: Evaluation[] = [];
for (const su of [100, 150, 200, 250]) starts.push(tryParams("seed", patchOf(chosenDefault, { start: "seed", seedUncertainty: su }), seed));
const firstPass = run(data, chosenDefault.params).state;
const twoPassSeed = new Map([...firstPass].map(([n, p]) => [n, p.sr]));
const twoPass = tryParams("two-pass (leaks)", patchOf(chosenDefault, { start: "seed", seedUncertainty: 150 }), twoPassSeed);
const seededBest = top(starts, 1)[0]; // seed uncertainty picked on tuning log-loss (inflated there, the same for all seeds)
writeFileSync(join(outDir, "sweep.tsv"), tsv.join("\n") + "\n");
say(`\nseed: formula ELO from player_history before ${splitTime}, ${seed.size} players`);
say(header);
for (const e of [reference, chosenDefault, ...starts, twoPass]) say(line(e));
const chosen = chosenDefault;

// Placement: the threshold is the uncertainty after n ideal rounds
// (derivePlacementUncertainty). Calibrated on the tuning period so that a
// typical player places after about 10 rated rounds; ratings don't change.
say("\nPLACEMENT CALIBRATION (tuning period; rated rounds to placement)");
const tuningOnly = { rounds: data.rounds.slice(0, split), extra: data.extra };
for (let n = 3; n <= 10; n++) {
  const threshold = derivePlacementUncertainty(chosen.params, n);
  const out = run(tuningOnly, { ...chosen.params, settings: { ...chosen.params.settings, placementUncertainty: threshold } });
  const xs = [...out.placedAfter.values()];
  say(`${n} ideal rounds: threshold ${f(threshold, 2)}; median ${quantile(xs, 0.5)}, p10 ${quantile(xs, 0.1)}, p90 ${quantile(xs, 0.9)} (${xs.length} players)${n === PLACEMENT_ROUNDS ? "  <- engine default" : ""}`);
}

// ---- held-out evaluation, once, after the choice is frozen ----
const runnerPicks = top(all.filter((e) => admissible(e) && describe(e.params) !== describe(chosen.params) && e.params.settings.start === "default"), 3);
const once = (e: Evaluation) => evaluate(data, e.label, e.params, e.seed, true);
const H = {
  chosen: once(chosen), reference: once(reference), best: once(bestUnconstrained), uncapped: once(current),
  seeded: once(seededBest), twoPass: once(twoPass), runners: runnerPicks.map(once),
};
const baseline = score(H.reference.out, (s) => s.base);
writeFileSync(join(outDir, "heldout.tsv"), [header, ...[H.chosen, H.reference, ...H.runners, H.best, H.uncapped, H.seeded, H.twoPass].map(line)].join("\n") + "\n");
say(`\nHELD OUT: ${H.reference.out.test.length} established pairs from ${splitTime}`);
say(`baseline formula ELO: test log-loss ${f(baseline.test.logLoss)}, Brier ${f(baseline.test.brier)}, order ${f(baseline.test.accuracy)} (k ${f(baseline.tune.k, 5)})`);

// Paired bootstrap over test rounds of the log-loss difference (negative:
// the first predicts better), 2000 resamples, fixed seed.
const lossBy = (out: RunOut, x: (s: PairSample) => number) => {
  const k = fitScale(out.tune, x);
  return out.test.map((s) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(k * x(s)))); return -(s.y * Math.log(q) + (1 - s.y) * Math.log(1 - q)); });
};
function bootstrap(a: number[], b: number[], samples: PairSample[]): string {
  const byRound = new Map<number, [number, number, number]>();
  samples.forEach((s, i) => { const t = byRound.get(s.r) ?? [0, 0, 0]; t[0] += s.w * a[i]; t[1] += s.w * b[i]; t[2] += s.w; byRound.set(s.r, t); });
  const rows = [...byRound.values()];
  let x = 12345;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const diffs: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sa = 0, sb = 0, sw = 0;
    for (let j = 0; j < rows.length; j++) { const t = rows[Math.floor(rnd() * rows.length)]; sa += t[0]; sb += t[1]; sw += t[2]; }
    diffs.push((sa - sb) / sw);
  }
  const all = rows.reduce((t, r) => [t[0] + r[0], t[1] + r[1], t[2] + r[2]], [0, 0, 0]);
  return `${f((all[0] - all[1]) / all[2], 5)} [${f(quantile(diffs, 0.025), 5)}, ${f(quantile(diffs, 0.975), 5)}]`;
}
const chosenRun = H.chosen;
const chosenLoss = lossBy(chosenRun.out, (s) => s.x);
const versus = (label: string, other: number[]) => say(`  chosen - ${label}: ${bootstrap(chosenLoss, other, chosenRun.out.test)}`);
say("\nPAIRED BOOTSTRAP, test log-loss difference (95% interval)");
versus("formula ELO", lossBy(H.reference.out, (s) => s.base));
versus("prototype M=5", lossBy(H.reference.out, (s) => s.x));
versus(`best unconstrained (${describe(bestUnconstrained.params)})`, lossBy(H.best.out, (s) => s.x));
if (chosen !== current) versus(`without the brief's cap (${describe(current.params)})`, lossBy(H.uncapped.out, (s) => s.x));
versus(`seeded (${describe(seededBest.params)})`, lossBy(H.seeded.out, (s) => s.x));

// Headline: chosen vs baseline vs runner-ups on the test period.
say("\nHEADLINE (test period, established pairs)");
say("variant\ttest log-loss\tBrier\torder accuracy\trange20 p50/p90\tdrop8 p50/p90/max\tweekly median crossings");
const head = (label: string, sc: Score, st?: Stability) => say([label, f(sc.logLoss), f(sc.brier), f(sc.accuracy),
  st ? `${f(st.range20Median, 0)}/${f(st.range20P90, 0)}` : "-", st ? `${f(st.drop8Median, 0)}/${f(st.drop8P90, 0)}/${f(st.drop8Max, 0)}` : "-",
  st ? `${f(st.weeklyCross, 0)} (${f(100 * st.weeklyCrossShare, 1)}%)` : "-"].join("\t"));
head(`chosen: ${describe(chosen.params)}`, H.chosen.test, H.chosen.held);
head("formula ELO baseline", baseline.test);
head(`prototype: ${describe(reference.params)}`, H.reference.test, H.reference.held);
for (const e of H.runners) head(`runner-up: ${describe(e.params)}`, e.test, e.held);
if (describe(bestUnconstrained.params) !== describe(chosen.params)) head(`best unconstrained: ${describe(bestUnconstrained.params)}`, H.best.test, H.best.held);
if (chosen !== current) head(`without the brief's cap: ${describe(current.params)}`, H.uncapped.test, H.uncapped.held);
head(`seeded: ${describe(seededBest.params)}`, H.seeded.test, H.seeded.held);
head("two-pass (leaks, interest only)", H.twoPass.test, H.twoPass.held);
say("\nSELECTION-TIME STABILITY (validation slice of the tuning period)");
for (const [label, e] of [["chosen", chosen], ["prototype", reference], ["best unconstrained", bestUnconstrained]] as const) {
  const st = e.stability;
  say(`${label}: range20 ${f(st.range20Median, 0)}/${f(st.range20P90, 0)}, drop8 ${f(st.drop8Median, 0)}/${f(st.drop8P90, 0)}/${f(st.drop8Max, 0)}, weekly crossings ${f(st.weeklyCross, 0)} (${f(100 * st.weeklyCrossShare, 1)}%)`);
}

// Leaderboard impact against the current formula leaderboard.
const final = run(data, chosen.params);
const info = new Map(players.map((p) => [p.name!, p]));
const qualifies = (n: string) => { const p = info.get(n); return !!p && p.is_banned !== "t" && (num(p.placement_matches) ?? 0) >= 10; };
const oldBoard = players.filter((p) => qualifies(p.name!) && num(p.elo) !== null).sort((a, b) => num(b.elo)! - num(a.elo)! || compareNames(a.name!, b.name!)).map((p) => p.name!);
const placed = [...final.state].filter(([n, p]) => qualifies(n) && isPlaced(p, chosen.params));
const newBoard = placed.sort((a, b) => cautiousSr(b[1], chosen.params) - cautiousSr(a[1], chosen.params)).map(([n]) => n);
say(`\nLEADERBOARD: formula ${oldBoard.length} placed, SR ${newBoard.length} placed; Spearman on shared players ${f(spearman(oldBoard, newBoard), 3)}`);
const shared = oldBoard.filter((n) => newBoard.includes(n));
const oRank = new Map(shared.map((n, i) => [n, i + 1]));
const nRank = new Map(newBoard.filter((n) => oRank.has(n)).map((n, i) => [n, i + 1]));
const topN = (b: string[], k: number) => new Set(b.filter((n) => oRank.has(n)).slice(0, k));
for (const k of [5, 10, 25]) {
  const a = topN(shared, k), b = topN(newBoard, k);
  say(`top ${k}: ${[...a].filter((n) => b.has(n)).length} in both`);
}
// Risers and fallers, described by their statistics.
const feat = (n: string) => {
  const p = info.get(n)!, s = final.state.get(n)!;
  return `kpm ${p.recent_kpm} acc ${p.recent_accuracy} kd ${p.recent_kdr} placements ${p.placement_matches} rated ${s.fullRounds}/${s.ratedWeight.toFixed(1)} ±${(2 * s.uncertainty).toFixed(0)}`;
};
const moves = shared.map((n) => [n, oRank.get(n)! - nRank.get(n)!] as const).sort((a, b) => b[1] - a[1]);
const anon = new Map<string, string>(); const alias = (n: string) => { if (!anon.has(n)) anon.set(n, `P${anon.size + 1}`); return anon.get(n)!; };
say("biggest risers (formula rank -> SR rank, statistics):");
for (const [n, d] of moves.slice(0, 12)) say(`  ${alias(n)}: ${oRank.get(n)} -> ${nRank.get(n)} (+${d}) ${feat(n)}`);
say("biggest fallers:");
for (const [n, d] of moves.slice(-12).reverse()) say(`  ${alias(n)}: ${oRank.get(n)} -> ${nRank.get(n)} (${d}) ${feat(n)}`);
const median = (xs: number[]) => quantile(xs, 0.5);
const group = (ns: string[], key: string) => f(median(ns.map((n) => num(info.get(n)![key]) ?? NaN).filter(Number.isFinite)), 2);
const up = moves.slice(0, 30).map(([n]) => n), down = moves.slice(-30).map(([n]) => n), mid = shared;
for (const key of ["recent_kpm", "recent_accuracy", "recent_kdr", "placement_matches"]) say(`median ${key}: top 30 risers ${group(up, key)}, top 30 fallers ${group(down, key)}, all shared ${group(mid, key)}`);
const placedNames = new Set(newBoard);
say(`formula-placed players not SR-placed: ${oldBoard.filter((n) => !placedNames.has(n)).length}`);
say(`mean SR of active players by day: ${final.snapshots.map((x) => `${x.day.slice(5)} ${f(x.activeMean, 1)}`).join(", ")}`);
const placedSr = newBoard.map((n) => final.state.get(n)!.sr);
say(`placed SR percentiles: p1 ${f(quantile(placedSr, 0.01), 0)}, p10 ${f(quantile(placedSr, 0.1), 0)}, p50 ${f(quantile(placedSr, 0.5), 0)}, p90 ${f(quantile(placedSr, 0.9), 0)}, p99 ${f(quantile(placedSr, 0.99), 0)}`);
const toPlace = [...final.placedAfter.values()];
say(`rated rounds to placement: median ${quantile(toPlace, 0.5)}, p10 ${quantile(toPlace, 0.1)}, p90 ${quantile(toPlace, 0.9)} (${toPlace.length} players)`);
{
  // The strong-player stress case at the chosen settings, all established:
  // an extreme gap, and the 99th against the 10th percentile of placed SR.
  for (const [hi, lo] of [[1800, 1400], [Math.round(quantile(placedSr, 0.99)), Math.round(quantile(placedSr, 0.1))]]) {
  const st: SrState = new Map((["S", ..."BCDEF"] as string[]).map((n) => [n, { sr: n === "S" ? hi : lo, uncertainty: chosen.params.settings.rdMin, ratedWeight: 20, fullRounds: 20, lastRatedAt: null }]));
  for (const k of [10, 20, 30, 45]) {
    const r: SrRound = { id: "x", playedAt: "2026-11-04T00:00:00Z", length: 300, winner: "S", participants: ["S", ..."BCDEF".split("")].map((n) => ({ name: n, kills: n === "S" ? 50 : k, present: 300, afk: 0, shots: null, intervals: [[0, 300]] as [number, number][] })) };
    const ev = rateRound(st, r, chosen.params).events.find((e) => e.name === "S")!;
    say(`strong player ${hi} wins 50 vs five ${lo}s on ${k}: expected ${f(ev.expectedShare, 3)}, actual ${f(ev.actualShare, 3)}, change ${f(ev.srAfter - ev.srBefore, 1)}`);
  }
  }
}

writeFileSync(join(outDir, "names.tsv"), [...anon].map(([n, a]) => `${a}\t${n}`).join("\n") + "\n");
writeFileSync(join(outDir, "report.txt"), log.join("\n") + "\n");
writeFileSync(join(outDir, "chosen.json"), JSON.stringify({ d: chosen.params.d, beta: chosen.params.beta, settings: chosen.params.settings }, null, 2) + "\n");
