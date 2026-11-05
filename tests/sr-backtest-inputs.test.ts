import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRounds, meanConcurrentSize, type Row } from '../scripts/sr-backtest-inputs.ts';
import { DEFAULT_SR_PARAMS, type SrRound } from '../supabase/functions/_shared/sr.ts';

const matches: Row[] = [
  { id: '11', player_name: 'AliceAlias', match_id: 'round', played_at: '2026-11-04T00:00:00Z', score: '1', time_in_lobby: '100', total_match_time: '300', shots: '100', afk_seconds: '10' },
  { id: '12', player_name: 'Alice', match_id: 'round', played_at: '2026-11-04T00:00:00Z', score: '2', time_in_lobby: '150', total_match_time: '300', shots: '100', afk_seconds: '20' },
  { id: '13', player_name: 'Bob', match_id: 'round', played_at: '2026-11-04T00:00:00Z', score: '1', time_in_lobby: '300', total_match_time: '300', shots: '100', afk_seconds: '0' },
];
const sessions: Row[] = [
  { participation_id: '11', session_no: '1', logged_name: 'AliceAlias', start_s: '0', end_s: '100', score_events: '[{"at_s":20,"score":1}]' },
  { participation_id: '12', session_no: '2', logged_name: 'Alice', start_s: '150', end_s: '300', score_events: '[{"at_s":200,"score":1},{"at_s":250,"score":2}]' },
  { participation_id: '13', session_no: '3', logged_name: 'Bob', start_s: '0', end_s: '300', score_events: '[{"at_s":50,"score":1}]' },
];
const logs: Row[] = [{ match_id: 'round', format_version: '3', round_length: '300', winner_name: 'AliceAlias' }];
const assemble = (data = matches, raw = logs, sessionRows = sessions, banned = new Set<string>()) =>
  assembleRounds(data, new Set(['Alice', 'Bob']), new Map([['alicealias', 'Alice']]), banned, raw, sessionRows);

test('backtest v3 assembly merges session-local score resets, aliases and exact presence', () => {
  const result = assemble();
  assert.equal(result.repointed, 1);
  assert.equal(result.merged, 1);
  const round = result.rounds[0];
  assert.equal(round.winner, 'Alice');
  assert.deepEqual(round.participants[0], { name: 'Alice', kills: 3, present: 250, afk: 30, shots: 200,
    intervals: [[0, 100], [150, 300]], scoreEvents: [{ at: 20, delta: 1 }, { at: 200, delta: 1 }, { at: 250, delta: 1 }] });
  assert.deepEqual(round.participants[1].scoreEvents, [{ at: 50, delta: 1 }]);
  const withoutVictim = assemble(matches, logs, sessions, new Set(['Bob']));
  assert.deepEqual(withoutVictim.rounds[0].participants[0], round.participants[0]);
});

test('backtest v2 uses sessions without inventing score histories; v1 retains its fallback', () => {
  const old = assemble(matches, [{ ...logs[0], format_version: '2' }], sessions.map(s => ({ ...s, score_events: null }))).rounds[0];
  assert.equal(old.participants[0].scoreEvents, undefined);
  assert.equal(old.participants[0].present, 250);
  const legacy = assemble(matches, [], []).rounds[0];
  assert.deepEqual(legacy.participants[0], { name: 'Alice', kills: 3, present: 150, afk: 0, shots: null, intervals: [[150, 300]] });
  assert.equal(legacy.winner, null);
  const mismatched = matches.map((r, i) => i ? r : { ...r, total_match_time: '100' });
  assert.equal(assemble(mismatched, [], []).skipped.length, 1);
  assert.equal(assemble(mismatched).rounds.length, 1); // structured round length is authoritative
});

test('backtest fails closed on incomplete v3 histories', () => {
  assert.throws(() => assemble(matches, logs, sessions.map((s, i) => i ? s : { ...s, score_events: null })), /Incomplete v3 histories/);
});

test('size reports retain low-shot scoring and genuine scoreless residents after a quiet prefix', () => {
  const round: SrRound = { id: 'waiting', playedAt: '2026-11-04', length: 2040, winner: 'P0',
    participants: Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, kills: i === 1 ? 0 : 1,
      present: i < 2 ? 2040 : 240, afk: 0, shots: 20, intervals: [[i < 2 ? 0 : 1800, 2040]],
      scoreEvents: i === 1 ? [] : [{ at: 2000, delta: 1 }],
    })) };
  assert.equal(meanConcurrentSize(round, DEFAULT_SR_PARAMS), 8);
  round.participants[1].shots = 0; // actual idle/no-effort participant is excluded
  assert.equal(meanConcurrentSize(round, DEFAULT_SR_PARAMS), 7);
});

test('backtest v4 keeps raw attendance and AFK totals across rejoins with explicit terminal endpoints', () => {
  const ss = sessions.map((s,i) => ({ ...s, afk_seconds: String(i === 0 ? 10 : i === 1 ? 20 : 0), afk_intervals: JSON.stringify(i === 0 ?
    [{ start_s: 90, end_s: 100, terminal: true }] : i === 1 ? [{ start_s: 200, end_s: 220, terminal: false }] : []) }));
  const round = assemble(matches, [{ ...logs[0], format_version: '4' }], ss).rounds[0];
  const a = round.participants[0];
  assert.equal(a.present, 250); assert.equal(a.afk, 30);
  assert.deepEqual(a.afkIntervals, [{ start: 90, end: 100, terminal: true }, { start: 200, end: 220, terminal: false }]);
  assert.equal(a.scoreEvents!.length, 3);
  assert.throws(() => assemble(matches, [{ ...logs[0], format_version: '4' }], sessions), /Incomplete v4 AFK/);
});

test('backtest concurrent-size reporting skips scoring actors at AFK entry just like the engine', () => {
  const p = (name: string) => ({name,kills:1,present:180,afk:0,shots:100,intervals:[[0,180]] as [number,number][],scoreEvents:[{at:100,delta:1}]});
  const r: SrRound = {id:'entry',playedAt:'2026-11-05T00:00:00Z',length:180,winner:null,participants:[
    {...p('A'),afk:40,afkIntervals:[{start:60,end:100,terminal:false}],scoreEvents:[{at:60,delta:1}]},p('B'),p('C'),
  ]};
  assert.equal(meanConcurrentSize(r,DEFAULT_SR_PARAMS),3);
});
