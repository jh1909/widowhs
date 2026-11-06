import assert from 'node:assert/strict';
import test from 'node:test';
import { SIZE_CURVE_SR_PARAMS as P, rateRound, lobbySizeWeight,
  type SrParticipant, type SrParams, type SrRound, type SrState } from '../supabase/functions/_shared/sr.ts';

const player = (name: string, kills: number, start = 0, end = 300): SrParticipant => ({
  name, kills, present: end - start, afk: 0, shots: 1000, intervals: [[start, end]],
  scoreEvents: Array.from({ length: kills }, (_, i) => ({ at: start + (i + 1) * (end - start) / (kills + 1), delta: 1 })),
});
const round = (participants: SrParticipant[], length = 300, winner: string | null = 'A'): SrRound =>
  ({ id: 'rolling', playedAt: '2026-11-04T00:00:00Z', length, winner, participants });
const state = (people: SrParticipant[]): SrState => new Map(people.map(p => [p.name,
  { sr: 1500, uncertainty: 80, ratedWeight: 20, fullRounds: 20, lastRatedAt: null }]));
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const parts = (n = 10, start = 0) => Array.from({ length: n }, (_, i) => player(String.fromCharCode(65 + i), i ? 25 : 50, start, start + 300));
const rate = (people: SrParticipant[], length = 300, params: SrParams = P) => rateRound(state(people), round(people, length), params);

test('rolling evidence follows the size curve, with the same ceiling for eight and twelve', () => {
  let previous = 0;
  for (let n = 2; n <= 12; n++) {
    const people = parts(n), result = rate(people);
    const winner = result.events[0];
    near(winner.weight, lobbySizeWeight(n, P.settings.lobbySize));
    assert.ok(winner.srAfter > 1500);
    if (n <= 8) assert.ok(winner.srAfter > previous);
    else near(winner.srAfter, previous);
    previous = winner.srAfter;
    for (const e of result.events) assert.ok(e.weight > 0 && e.weight <= 1 + 1e-12);
  }
});

test('thirty minutes before a full four-minute contest cannot dilute its evidence', () => {
  const baselinePeople = parts().map(p => player(p.name, p.kills, 0, 240));
  const baseline = rate(baselinePeople, 240);
  // Identical scoring and shared play, with an empty 30-minute prefix.
  const delayedPeople = parts(10, 1800).map(p => player(p.name, p.kills, 1800, 2040));
  const afterWaiting = rate(delayedPeople, 2040);
  // A resident waited alone or AFK; other players join only for the contest.
  const resident = [...delayedPeople];
  resident[0] = { ...resident[0], present: 2040, afk: 1800, intervals: [[0, 2040]] };
  const afterResidentWait = rate(resident, 2040);
  const movingWait = [...resident];
  movingWait[0] = { ...resident[0], afk: 0, shots: 50 }; // waiting while moving, then 50 successful shots
  for (const result of [afterWaiting, afterResidentWait, rate(movingWait, 2040)]) {
    for (let i = 0; i < baseline.events.length; i++) {
      const a = baseline.events[i], b = result.events[i];
      near(a.srAfter, b.srAfter); near(a.uncertaintyAfter, b.uncertaintyAfter);
      near(a.weight, b.weight); near(a.actualShare, b.actualShare);
    }
  }
});

test('actual early duelling stays low weight and does not become a late opponent\'s score', () => {
  const people = parts(10, 1800);
  people[0] = player('A', 45, 1800, 2100);
  for (let i = 0; i < 2; i++) people[i] = { ...people[i],
    kills: people[i].kills + 5, present: 2100, intervals: [[0, 2100]],
    scoreEvents: [...player(people[i].name, 5, 0, 1800).scoreEvents!, ...people[i].scoreEvents!],
  };
  const result = rate(people, 2100);
  const pair = result.pairs.find(p => p.a === 'A' && p.b === 'C')!;
  near(pair.shareA, 45 / 70 + P.beta * 25 / 70); // the earlier five kills are outside their shared play
  const clean = rate(parts());
  assert.ok(result.events[0].weight < clean.events[0].weight);
  // Extra early scoring cannot supply more than a full round of evidence.
  assert.ok(result.events.every(e => e.weight <= 1 + 1e-12));
});

test('waiting cannot exclude a genuine zero-score participant through a whole-session shot rate', () => {
  const people = parts(8).map((p, i) => i === 1 ? { ...player(p.name, 0), shots: 20 } : p);
  const baseline = rate(people);
  const delayed = people.map(p => ({ ...p, intervals: [[1800, 2100]] as [number, number][],
    scoreEvents: p.scoreEvents!.map(e => ({ ...e, at: e.at + 1800 })) }));
  delayed[1] = { ...delayed[1], present: 2100, intervals: [[0, 2100]] };
  const result = rate(delayed, 2100);
  assert.equal(result.events.length, baseline.events.length);
  for (let i = 0; i < baseline.events.length; i++) near(result.events[i].srAfter, baseline.events[i].srAfter);
  const idle = people.map((p, i) => i === 1 ? { ...p, shots: 0 } : p);
  assert.equal(rate(idle).excluded.find(e => e.name === 'B')!.reason, 'effort');
});

test('stretching the same early duel from three to thirty minutes changes no rating evidence', () => {
  const scenario = (prefix: number) => {
    const people = parts(10, prefix);
    people[0] = player('A', 45, prefix, prefix + 300);
    for (let i = 0; i < 2; i++) people[i] = { ...people[i], kills: people[i].kills + 5,
      present: prefix + 300, intervals: [[0, prefix + 300]],
      scoreEvents: [...player(people[i].name, 5, 0, prefix).scoreEvents!, ...people[i].scoreEvents!],
    };
    return rate(people, prefix + 300);
  };
  const quick = scenario(180), slow = scenario(1800);
  for (let i = 0; i < quick.events.length; i++) {
    near(quick.events[i].srAfter, slow.events[i].srAfter);
    near(quick.events[i].weight, slow.events[i].weight);
    near(quick.events[i].uncertaintyAfter, slow.events[i].uncertaintyAfter);
  }
});

test('brief low-scoring joins provide little evidence, while an actual fast win can count fully', () => {
  const people = parts(8);
  people.push(player('Late', 1, 270, 300));
  const late = rate(people).events.find(e => e.name === 'Late')!;
  assert.ok(late.weight > 0 && late.weight < 0.15);
  const fast = parts(8, 270).map(p => player(p.name, p.kills, 270, 300));
  near(rate(fast).events[0].weight, 1); // 50 real scoring observations, independent of wall time
});

test('replacing duel opponents does not multiply a full-round evidence budget', () => {
  const continuous = [player('A', 50), player('B', 48)];
  const replaced = [player('A', 50), player('B', 24, 0, 150), player('C', 24, 150, 300)];
  const a = rate(continuous).events[0], b = rate(replaced).events[0];
  near(a.weight, 0.05); near(b.weight, 0.05);
  near(a.srAfter, b.srAfter); near(a.uncertaintyAfter, b.uncertaintyAfter);
});

test('environmental losses affect shared results and never create positive evidence', () => {
  const a = player('A', 10), b = player('B', 10);
  const clean = rateRound(state([a, b]), round([a, b], 300, null), P);
  const loss = { ...a, kills: 9, scoreEvents: [...a.scoreEvents!, { at: 299, delta: -1 }] };
  const result = rateRound(state([loss, b]), round([loss, b], 300, null), P);
  near(result.pairs[0].shareA, 9 / 19);
  near(result.events[0].weight, clean.events[0].weight);
  assert.ok(result.events[0].srAfter < 1500);
});

test('the evidence target is tunable and invalid/partial histories fail closed', () => {
  const people = parts(8);
  const slower = rate(people, 300, { ...P, settings: { ...P.settings, rollingEvidenceKills: 100 } });
  assert.ok(slower.events[0].weight < rate(people).events[0].weight);
  const unknown = people.map((p, i) => i ? p : { ...p, scoreEvents: undefined });
  assert.throws(() => rate(unknown), /incomplete_score_events/);
  for (const event of [{ at: 301, delta: 1 }, { at: 1, delta: 0 }, { at: NaN, delta: 1 }]) {
    assert.throws(() => rate(people.map((p, i) => i ? p : { ...p, scoreEvents: [event] })), /invalid_score_event/);
  }
  assert.throws(() => rate(people, 300, { ...P, settings: { ...P.settings, rollingEvidenceKills: 0 } }), /invalid_rolling_evidence/);
});

test('old logs have an explicit time fallback, and a higher cutoff leaves small play unrated', () => {
  const old = parts(2).map(({ scoreEvents, ...p }) => p);
  const fallback = rate(old);
  const previous = rate(old, 300, { ...P, settings: { ...P.settings, rollingEvidenceKills: undefined } });
  assert.deepEqual(fallback, previous);
  const params = { ...P, settings: { ...P.settings, lobbySize: { ...P.settings.lobbySize!, minPlayers: 3 } } };
  assert.deepEqual(rate(parts(2), 300, params).events, []);
});

test('exact AFK intervals exclude entry and terminal win but include actual return, without losing session score history', () => {
  const baseline = [player('A', 4, 0, 180), player('B', 3, 0, 180), player('C', 0, 0, 180)];
  baseline[0].scoreEvents = [60, 80, 100, 180].map(at => ({ at, delta: 1 }));
  baseline[1].scoreEvents = [50, 110, 170].map(at => ({ at, delta: 1 }));
  const people = baseline.map(p => p.name === 'C' ? { ...p, afk: 40,
    afkIntervals: [{ start: 60, end: 100, terminal: false }, { start: 180, end: 180, terminal: true }] } : p);
  const result = rate(people, 180);
  const ab = result.pairs.find(p => p.a === 'A' && p.b === 'B')!;
  const ac = result.pairs.find(p => p.a === 'A' && p.b === 'C')!;
  assert.ok(ab.weight > ac.weight); // C misses entry, mid-break and winning event.
  const removeTerminal = people.map(p => p.name === 'C' ? { ...p, afkIntervals: p.afkIntervals!.slice(0,1) } : p);
  assert.ok(rate(removeTerminal, 180).pairs.find(p => p.b === 'C')!.weight > ac.weight);
  // No ongoing interval subtraction from eligibility: total active remains 140.
  assert.equal(result.excluded.length, 0);
});
