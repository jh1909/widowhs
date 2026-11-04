import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SR_PARAMS as P, applyRound, cautiousSr, compareNames, compareRounds, derivePlacementUncertainty, isPlaced, rateRound, replay, timeKey,
  type SrParams, type SrParticipant, type SrPlayer, type SrRound, type SrState,
} from "../supabase/functions/_shared/sr.ts";

const L = 300;
const v1 = (name: string, kills: number, present = L, length = L): SrParticipant =>
  ({ name, kills, present, afk: 0, shots: null, intervals: [[length - present, length]] });
const v2 = (name: string, kills: number, intervals: [number, number][], shots: number, afk = 0): SrParticipant => ({
  name, kills, afk, shots, intervals, present: intervals.reduce((t, [s, e]) => t + e - s, 0),
});
const round = (participants: SrParticipant[], winner: string | null = null, id = "r1", playedAt = "2026-10-01T12:00:00Z", length = L): SrRound =>
  ({ id, playedAt, length, winner, participants });
const established = (sr: number, uncertainty = 50): SrPlayer => ({ sr, uncertainty, ratedWeight: 20, fullRounds: 20, lastRatedAt: null });
const lobby = (ratings: Record<string, number>, uncertainty = 50): SrState =>
  new Map(Object.entries(ratings).map(([name, sr]) => [name, established(sr, uncertainty)]));
const change = (result: ReturnType<typeof rateRound>) =>
  Object.fromEntries(result.events.map((e) => [e.name, e.srAfter - e.srBefore]));
const withSettings = (settings: Partial<SrParams["settings"]>, top: Partial<SrParams> = {}): SrParams =>
  ({ ...P, ...top, settings: { ...P.settings, ...settings } });
const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const names = "ABCDEFGHIJKL".split("");
const even = Object.fromEntries(names.map((n) => [n, 1500]));

test("golden: the default params, a new winner against an established player", () => {
  const state = new Map([["B", established(1600, 80)]]);
  const result = rateRound(state, round([v1("A", 50), v1("B", 30)], "A"), P);
  const [a, b] = result.events;
  // Independently computed (Glicko-1 with D = 300, m = 12, rd0 160, beta = 0.05, cap 0.25).
  near(a.srAfter, 1622.2624310841677);
  near(a.uncertaintyAfter, 74.87185208162713);
  near(a.expectedShare, 0.3258533248375812);
  near(a.actualShare, 0.64375); // 50/80 = 0.625, plus 0.05 of the remainder
  near(b.srAfter, 1528.3129925902435);
  near(b.uncertaintyAfter, 61.317154918671946);
  near(b.expectedShare, 0.6537486564520368);
  assert.deepEqual([result.pairs[0].surpriseA, result.pairs[0].surpriseB], [0.25, -0.25]);
});

test("golden: the prototype's settings, a new winner against an established player", () => {
  const prototype = withSettings({ m: 5, rd0: 350, rdMin: 50 }, { d: 400, beta: 0.1 });
  const state = new Map([["B", established(1600, 80)]]);
  const result = rateRound(state, round([v1("A", 50), v1("B", 30)], "A"), prototype);
  const [a, b] = result.events;
  // Independently computed (Glicko-1 with D = 400, M = 5, beta = 0.1, cap 0.25).
  near(a.srAfter, 1657.7966963042845);
  near(a.uncertaintyAfter, 150.41764204908685);
  near(a.expectedShare, 0.36402339238327275);
  near(a.actualShare, 0.6625); // 50/80 = 0.625, plus 0.1 of the remainder
  near(b.srAfter, 1572.3506502841287);
  near(b.uncertaintyAfter, 75.78338896376621);
  near(b.expectedShare, 0.5951139680019167);
  near(a.performance, a.actualShare - a.expectedShare);
  assert.equal(result.pairs[0].surpriseA, 0.25);
});

test("defaults: placement is the uncertainty after ten full rounds; cautious SR is SR minus twice it", () => {
  assert.equal(P.settings.placementUncertainty, derivePlacementUncertainty(P));
  near(P.settings.placementUncertainty, 30); // the floor, reached after 7 ideal rounds
  assert.ok(derivePlacementUncertainty(P, 6) > 30);
  assert.ok(derivePlacementUncertainty(withSettings({ m: 2 })) > 30); // a slower setting places later
  const player = established(1600, 60);
  assert.equal(cautiousSr(player, P), 1480);
  assert.equal(isPlaced(player, P), false);
  assert.equal(isPlaced(established(1600, 30), P), true);
});

test("ten full rounds take a new player from unplaced to placed", () => {
  const state: SrState = lobby({ X: 1500, Y: 1500 });
  for (let i = 0; i < 12; i++) {
    const r = round([v1("N", 40), v1("X", 45), v1("Y", 42)], null, `r${String(i).padStart(2, "0")}`);
    applyRound(state, r, rateRound(state, r, P));
    if (i === 3) assert.equal(isPlaced(state.get("N")!, P), false);
  }
  assert.equal(isPlaced(state.get("N")!, P), true);
  assert.equal(state.get("N")!.fullRounds, 12);
});

test("eleven players on 49, winner on 50: the winner's gain is small", () => {
  const close = change(rateRound(lobby(even), round(names.map((n, i) => v1(n, i ? 49 : 50)), "A"), P));
  const dominant = change(rateRound(lobby(even), round(names.map((n, i) => v1(n, i ? 25 : 50)), "A"), P));
  assert.ok(close.A > 0 && close.A < dominant.A / 3, `${close.A} vs ${dominant.A}`);
  for (const n of names.slice(1)) near(close[n], -close.A / 11, 1e-9); // zero-sum, spread over the lobby
});

test("top three within 5 kills, fourth 18 behind: the fourth loses to all three", () => {
  const result = rateRound(lobby({ A: 1500, B: 1500, C: 1500, D: 1500 }), round([v1("A", 50), v1("B", 47), v1("C", 45), v1("D", 32)], "A"), P);
  const vsD = result.pairs.filter((p) => p.b === "D");
  assert.equal(vsD.length, 3);
  for (const p of vsD) assert.ok(p.surpriseB < 0);
  const d = change(result);
  assert.ok(d.D < 0 && d.A > d.B && d.B > d.D && d.C > d.D);
});

test("a strong player in a weak lobby gains almost nothing for winning", () => {
  const weak = "BCDEF".split("");
  const result = (ratings: Record<string, number>, others: number) =>
    change(rateRound(lobby(ratings), round([v1("S", 50), ...weak.map((n) => v1(n, others))], "S"), P)).S;
  const evenGain = result({ S: 1500, ...Object.fromEntries(weak.map((n) => [n, 1500])) }, 20);
  // About the 99th against the 10th percentile of placed players in the backtest.
  const weakLobby = { S: 1675, ...Object.fromEntries(weak.map((n) => [n, 1450])) };
  assert.ok(evenGain > 10);
  assert.ok(result(weakLobby, 20) < 1);
  assert.ok(result(weakLobby, 45) < 0); // a narrow win costs rating there
});

test("a late joiner at 45 s counts for little; at 20 s not at all", () => {
  const base = [v1("A", 50), v1("B", 40)];
  const late = rateRound(lobby({ A: 1500, B: 1500, C: 1500 }), round([...base, v1("C", 3, 45)], "A"), P);
  const full = rateRound(lobby({ A: 1500, B: 1500, C: 1500 }), round([...base, v1("C", 3 * 300 / 45)], "A"), P);
  const c = late.events.find((e) => e.name === "C")!;
  near(c.weight, 0.15);
  assert.ok(Math.abs(change(late).C) < Math.abs(change(full).C) / 3);
  assert.ok(late.pairs.every((p) => p.b !== "C" || p.weight <= 0.15 * P.settings.m / 2 + 1e-12));

  const absent = rateRound(lobby({ A: 1500, B: 1500 }), round(base, "A"), P);
  const brief = rateRound(lobby({ A: 1500, B: 1500, C: 1500 }), round([...base, v1("C", 5, 20)], "A"), P);
  assert.deepEqual(brief.excluded, [{ name: "C", reason: "short" }]);
  assert.deepEqual(brief.events, absent.events);
  assert.equal(brief.lobby!.players, 2);
});

test("participation uses active time: AFK time is subtracted before the 30 s cutoff and the weight", () => {
  const result = rateRound(new Map(), round([v1("A", 50), v2("B", 2, [[0, 100]], 40, 75), v2("C", 30, [[0, 300]], 300, 150)]), P);
  assert.deepEqual(result.excluded, [{ name: "B", reason: "short" }]);
  near(result.events.find((e) => e.name === "C")!.weight, 0.5);
});

test("tied kills between equal players change nothing", () => {
  const result = rateRound(lobby({ A: 1500, B: 1500 }), round([v1("A", 30), v1("B", 30)]), P);
  for (const e of result.events) { near(e.srAfter, 1500); near(e.performance, 0); }
});

test("0-0 pairs are skipped; a player with only 0-0 pairs is not rated", () => {
  const result = rateRound(lobby({ A: 1500, B: 1500, C: 1500 }), round([v1("A", 50), v1("B", 0), v1("C", 0)], "A"), P);
  assert.deepEqual(result.pairs.map((p) => p.a + p.b), ["AB", "AC"]);
  const none = rateRound(new Map(), round([v1("A", 0), v1("B", 0)]), P);
  assert.deepEqual(none.events, []);
  assert.equal(none.lobby!.players, 2);
});

test("two-player lobbies are rated and zero-sum at equal uncertainty", () => {
  const d = change(rateRound(lobby({ A: 1550, B: 1450 }), round([v1("A", 50), v1("B", 41)], "A"), P));
  near(d.A + d.B, 0);
  assert.ok(d.A !== 0);
});

test("zero-sum: rating changes sum to zero at equal uncertainty, the bonus only redistributes", () => {
  const ratings = Object.fromEntries(names.slice(0, 6).map((n) => [n, 1500]));
  for (const winner of [null, "A"]) {
    const d = change(rateRound(lobby(ratings), round(names.slice(0, 6).map((n, i) => v1(n, 50 - 7 * i)), winner), P));
    near(Object.values(d).reduce((a, b) => a + b, 0), 0);
  }
  for (const p of rateRound(lobby({ A: 1700, B: 1450, C: 1500 }), round([v1("A", 10), v1("B", 50), v1("C", 30)], "B"), P).pairs) {
    near(p.surpriseA + p.surpriseB, 0); // each pair stays zero-sum, capped or not
  }
});

test("the winner's bonus: a bigger win scores more, small wins gain most from it", () => {
  const share = (other: number) => rateRound(new Map(), round([v1("A", 50), v1("B", other)], "A"), P).pairs[0].shareA;
  near(share(49), 50 / 99 + P.beta * 49 / 99);
  near(share(10), 50 / 60 + P.beta * 10 / 60);
  assert.ok(share(10) > share(30) && share(30) > share(49));
  assert.ok(share(49) - 50 / 99 > share(10) - 50 / 60);
  const loser = rateRound(new Map(), round([v1("A", 49), v1("B", 50)], "B"), P).pairs[0].shareA;
  near(loser, 1 - share(49));
});

test("a rejoin: two intervals for one participant, kills pro-rated to the exact overlap", () => {
  // A was present 0-100 and 200-300; B the whole round. B's kills count 200/300.
  const result = rateRound(lobby({ A: 1500, B: 1500 }), round([v2("A", 20, [[200, 300], [0, 100]], 200), v2("B", 45, [[0, 300]], 400)]), P);
  near(result.pairs[0].shareA, 20 / (20 + 45 * 200 / 300));
  near(result.pairs[0].weight, (200 / 300) * P.settings.m);
  // The same as a v1 row present for 200 s.
  const flat = rateRound(lobby({ A: 1500, B: 1500 }), round([v1("A", 20, 200), v1("B", 45)]), P);
  near(flat.pairs[0].shareA, result.pairs[0].shareA);
  // Players who never shared the lobby have no pair.
  const apart = rateRound(new Map(), round([v2("A", 20, [[0, 100]], 200), v2("B", 25, [[150, 300]], 300), v1("C", 50)], "C"), P);
  assert.deepEqual(apart.pairs.map((p) => p.a + p.b), ["AC", "BC"]);
});

test("v1 pro-rating reduces to the prototype's rule: the longer-present player's kills scale to the shorter time", () => {
  const result = rateRound(new Map(), round([v1("A", 30, 120), v1("B", 50)]), P);
  near(result.pairs[0].shareA, 30 / (30 + 50 * 120 / 300));
  near(result.pairs[0].weight, 0.4 * P.settings.m);
});

test("the surprise cap bounds a freak round", () => {
  const state = lobby({ A: 1800, B: 1500, C: 1500 });
  const freak = round([v1("A", 0), v1("B", 50), v1("C", 45)], "B");
  const capped = rateRound(state, freak, P);
  const uncapped = rateRound(state, freak, withSettings({ surpriseCap: null }));
  const drop = -change(capped).A;
  assert.ok(drop > 0 && drop < -change(uncapped).A);
  // At most cap x the round's full weight, scaled by K = q / (1/RD^2 + q^2 * sum).
  const q = Math.LN10 / P.d;
  assert.ok(drop <= q * 50 * 50 * P.settings.m * P.settings.surpriseCap!);
  for (const p of capped.pairs) assert.ok(Math.abs(p.surpriseA) <= 0.25 && Math.abs(p.surpriseB) <= 0.25);
});

test("effort: v2 sessions with almost no shots per active minute are excluded both ways; v1 rows never", () => {
  const players = [v2("A", 50, [[0, 300]], 400), v2("B", 30, [[0, 300]], 300)];
  const without = rateRound(lobby({ A: 1500, B: 1500 }), round(players, "A"), P);
  const idler = rateRound(lobby({ A: 1500, B: 1500, Z: 1500 }), round([...players, v2("Z", 0, [[0, 300]], 9)], "A"), P);
  assert.deepEqual(idler.excluded, [{ name: "Z", reason: "effort" }]);
  assert.deepEqual(idler.events, without.events); // an excluded player doesn't affect others
  assert.deepEqual(idler.pairs, without.pairs);
  assert.deepEqual(idler.lobby, without.lobby);
  const trying = rateRound(new Map(), round([...players, v2("Z", 0, [[0, 300]], 10)], "A"), P);
  assert.equal(trying.excluded.length, 0); // 2 shots per minute is enough
  const old = rateRound(new Map(), round([...players, v1("Z", 0)], "A"), P);
  assert.equal(old.excluded.length, 0);
});

test("lobby size doesn't change how much one round can move a rating", () => {
  const two = change(rateRound(lobby({ A: 1500, B: 1500 }), round([v1("A", 50), v1("B", 25)], "A"), P)).A;
  const twelve = change(rateRound(lobby(even), round(names.map((n, i) => v1(n, i ? 25 : 50)), "A"), P)).A;
  near(two, twelve);
});

test("lobby strength: time-weighted mean pre-round SR, lowest and highest", () => {
  const result = rateRound(lobby({ A: 1600, B: 1400, C: 1900 }), round([v1("A", 50), v1("B", 30), v1("C", 5, 60), v1("D", 1, 10)], "A"), P);
  assert.deepEqual(result.lobby, { roundId: "r1", players: 3, meanSr: (1600 + 1400 + 0.2 * 1900) / 2.2, minSr: 1400, maxSr: 1900 });
});

test("the logistic share curve works on the pro-rated kill difference", () => {
  const params = withSettings({ shareCurve: "logistic", logisticScale: 10 });
  const share = (a: number, b: number) => rateRound(new Map(), round([v1("A", a), v1("B", b)]), params).pairs[0]?.shareA;
  near(share(30, 20)!, 1 / (1 + Math.exp(-1)));
  near(share(25, 25)!, 0.5);
  assert.ok(share(50, 10)! > share(50, 40)!);
  assert.equal(share(0, 0), undefined);
});

test("seeded start: players in the frozen seed map start from it at the seed uncertainty", () => {
  const params = withSettings({ start: "seed" });
  const seed = new Map([["A", 1700]]);
  const result = rateRound(new Map(), round([v1("A", 40), v1("B", 40)]), params, seed);
  assert.deepEqual(result.events.map((e) => [e.name, e.srBefore, e.uncertaintyBefore]), [["A", 1700, P.settings.seedUncertainty], ["B", 1500, P.settings.rd0]]);
  assert.throws(() => rateRound(new Map(), round([v1("A", 40), v1("B", 40)]), params), /seed_required/);
});

test("participants are rated in the order given; interval order never matters, participant order only to rounding", () => {
  const players = [v1("zed", 50), v1("Ålice", 44), v1("Bob", 31, 200), v2("😀", 12, [[200, 300], [0, 60]], 80), v1("bob", 0), v1("Al", 0, 100)];
  const state = lobby({ zed: 1620, "Ålice": 1480, Bob: 1550 });
  const expected = rateRound(state, round(players, "zed"), P);
  assert.deepEqual(expected.events.map((e) => e.name), ["zed", "Ålice", "Bob", "😀", "bob", "Al"]);
  assert.deepEqual(expected.pairs.slice(0, 2).map((p) => p.a + p.b), ["zedÅlice", "zedBob"]);
  const reversedIntervals = players.map((p) => ({ ...p, intervals: p.intervals.slice().reverse() }));
  assert.deepEqual(rateRound(state, round(reversedIntervals, "zed"), P), expected);
  const byName = (r: ReturnType<typeof rateRound>) => new Map(r.events.map((e) => [e.name, e]));
  const want = byName(expected);
  for (let seed = 1; seed < 20; seed++) {
    let x = seed;
    const shuffled = players.map((p) => ({ p, k: (x = (x * 1103515245 + 12345) % 2147483648) })).sort((a, b) => a.k - b.k).map(({ p }) => p);
    const got = rateRound(state, round(shuffled, "zed"), P);
    for (const [name, e] of byName(got)) {
      const w = want.get(name)!;
      for (const key of ["srAfter", "uncertaintyAfter", "expectedShare", "actualShare", "performance"] as const) near(e[key], w[key], 1e-12 * Math.max(1, Math.abs(w[key])));
    }
    near(got.lobby!.meanSr, expected.lobby!.meanSr, 1e-9);
  }
  assert.ok(compareNames("\uFFFF", "😀") < 0); // round ids tie-break by code point; UTF-16 order would put the emoji first
  assert.throws(() => rateRound(state, round([v1("A", 1), v1("B", 2), v1("A", 2)]), P), /duplicate_participant:A/);
});

test("replay from scratch equals incremental rateRound calls, in played_at then id order", () => {
  const pool = ["A", "B", "C", "D", "E", "F", "G"];
  const rounds: SrRound[] = [];
  let x = 7;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 60; i++) {
    const lobbySize = 2 + Math.floor(rnd() * 5);
    const chosen = pool.slice().sort(() => rnd() - 0.5).slice(0, lobbySize);
    const parts = chosen.map((n, j) => v1(n, j === 0 ? 50 : Math.floor(rnd() * 50), j === 0 ? L : 20 + Math.floor(rnd() * 280)));
    rounds.push(round(parts, chosen[0], `m${i % 3}`, new Date(Date.UTC(2026, 9, 1, 0, Math.floor(i / 3))).toISOString()));
  }
  const shuffled = rounds.slice().reverse();
  const full = replay(shuffled, P);
  const state: SrState = new Map();
  const ordered = rounds.slice().sort((a, b) => a.playedAt.localeCompare(b.playedAt) || a.id.localeCompare(b.id));
  for (const r of ordered) applyRound(state, r, rateRound(state, r, P));
  assert.deepEqual([...full.state.entries()].sort(), [...state.entries()].sort());
  // Resuming from a mid-history state gives the same result as replaying it all.
  const half = replay(ordered.slice(0, 30), P).state;
  for (const r of ordered.slice(30)) applyRound(half, r, rateRound(half, r, P));
  assert.deepEqual([...half.entries()].sort(), [...state.entries()].sort());
  assert.ok([...state.values()].some((p) => p.sr !== 1500));
});

test("round order keeps microseconds: rounds under a millisecond apart follow time, not id", () => {
  const first = round([v1("A", 50), v1("B", 10)], "A", "zzz", "2026-10-01 12:00:00.000100+00");
  const second = round([v1("A", 10), v1("B", 50)], "B", "aaa", "2026-10-01 12:00:00.000900+00");
  assert.ok(compareRounds(first, second) < 0);
  const state: SrState = new Map();
  for (const r of [first, second]) applyRound(state, r, rateRound(state, r, P));
  assert.deepEqual(replay([second, first], P).state, state);
  assert.equal(timeKey("2026-10-01T14:00:00.5+02:00"), timeKey("2026-10-01 12:00:00.500000Z"));
  assert.equal(compareRounds({ id: "b", playedAt: "2026-10-01T12:00:00Z" }, { id: "a", playedAt: "2026-10-01 12:00:00+00" }), 1);
});
