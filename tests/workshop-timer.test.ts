import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workshop = await readFile(new URL('../workshop/widowhs.ows', import.meta.url), 'utf8');
const rule = (name: string) => workshop.split(`rule("${name}")`)[1].split('\nrule(')[0];
const assignment = (name: string, target: string) => {
  const start = rule(name).split(`${target} = `)[1];
  assert.ok(start, `${name}: ${target}`);
  return start.split(';')[0];
};

type Clock = { now: number; end: number; complete: boolean; open: number[]; closed: number[] };
type Player = { session: number; startTime: number; score: number; playerTime?: number };

// Evaluate the arithmetic actually used by the Workshop, rather than a second
// implementation of its timer. This does not validate Workshop syntax/scheduling.
function translate(source: string): string {
  return source.replace(/Modify Global Variable\([^;]+;/g, '').replaceAll('Global.sessionAfkStart', 'state.open')
    .replaceAll('Global.sessionAfk', 'state.closed')
    .replaceAll('Global.gameComplete', 'state.complete')
    .replaceAll('Global.endTime', 'state.end')
    .replaceAll('Global.logIndex', 'player.session')
    .replaceAll('Global.topKPMPlayer', 'player')
    .replaceAll('Event Player', 'player').replaceAll('Current Array Element', 'player')
    .replaceAll('Total Time Elapsed', 'state.now')
    .replaceAll('Score Of(', 'scoreOf(').replaceAll('Max(', 'Math.max(').replaceAll('Min(', 'Math.min(');
}
const evaluate = (source: string, state: Clock, player: Player): number =>
  new Function('state', 'player', 'scoreOf', `return (${translate(source)});`)(state, player, (p: Player) => p.score);
const timer = assignment('Per player timer', 'Event Player.playerTime');
const kpm = assignment('Per player timer', 'Event Player.KPM');

test('Workshop active timer pauses, resumes and freezes at the win, with a safe zero-time KPM', () => {
  const player: Player = { session: 1, startTime: 10, score: 10 };
  const clock: Clock = { now: 70, end: 0, complete: false, open: [0, 0], closed: [0, 0] };
  const check = (seconds: number) => {
    player.playerTime = evaluate(timer, clock, player);
    assert.equal(player.playerTime, seconds);
    assert.equal(evaluate(kpm, clock, player), seconds ? 10 / (seconds / 60) : 0);
  };
  check(60);
  clock.open[1] = 70; clock.now = 130; check(60); // Idle time cannot lower KPM.
  clock.closed[1] = 60; clock.open[1] = 0; check(60); // Return doesn't jump the timer.
  clock.now = 190; check(120);
  clock.open[1] = 190; clock.now = 250; check(120); // Second AFK period.
  clock.complete = true; clock.end = 230; clock.now = 300; check(120);
  clock.closed[1] += clock.end - clock.open[1]; clock.open[1] = 0; check(120);
  clock.complete = false; clock.now = 10; clock.closed[1] = 0; check(0);
  clock.now = 0; check(0); // The timer has not started yet.
});

test('closing AFK for the log is idempotent and does not double-subtract it from the timer', () => {
  const block = rule('Match log').match(/If\(Global\.sessionAfkStart\[Global\.logIndex\]\);[\s\S]*?End;/)![0];
  const close = new Function('state', 'player', translate(block)
    .replace(/^If\((.*?)\);/, 'if ($1) {').replace('End;', '}'));
  const player: Player = { session: 1, startTime: 10, score: 50 };
  const clock: Clock = { now: 301, end: 300, complete: true, open: [0, 180], closed: [0, 60] };
  assert.equal(evaluate(timer, clock, player), 110);
  close(clock, player);
  assert.equal(clock.closed[1], 180);
  assert.equal(evaluate(timer, clock, player), 110);
  close(clock, player);
  assert.equal(clock.closed[1], 180);
  assert.equal(evaluate(timer, clock, player), 110);
});

test('final KPM ranks by exact active time, independent of the last timer tick and log ordering', () => {
  const ranking = assignment('Final top stats', 'Global.topKPMPlayer');
  const key = ranking.slice(ranking.lastIndexOf('), Score Of(') + 3, -2);
  const value = assignment('Final top stats', 'Global.topKPM');
  const clock: Clock = { now: 310, end: 300, complete: true, open: [0, 180, 0], closed: [0, 60, 0] };
  const players: Player[] = [
    { session: 1, startTime: 0, score: 50, playerTime: 999 },
    { session: 2, startTime: 0, score: 60, playerTime: 1 },
  ];
  for (const closed of [false, true]) {
    if (closed) { clock.closed[1] = 180; clock.open[1] = 0; }
    const sorted = [...players].sort((a, b) => evaluate(key, clock, b) - evaluate(key, clock, a));
    assert.equal(sorted[0].session, 1); // 25 active KPM beats 12, despite fewer kills.
    assert.equal(evaluate(value, clock, sorted[0]), 25);
    for (const player of players) {
      player.playerTime = evaluate(timer, clock, player);
      assert.equal(evaluate(key, clock, player), evaluate(kpm, clock, player));
    }
  }
});

test('existing return, leave and win actions preserve every AFK break before clearing its open timestamp', () => {
  const captured: { session: number[]; start: number[]; end: number[]; terminal: number[] } =
    {session:[],start:[],end:[],terminal:[]};
  const state: Clock = {now:100,end:180,complete:false,open:[0,60],closed:[0,0]};
  const player: Player = {session:1,startTime:0,score:0};
  const close = (name: string) => {
    const block = rule(name).match(/Modify Global Variable\(afkTerminal,[\s\S]*?Global\.sessionAfkStart\[[^\]]+\] = 0;/)![0];
    const code = block.replace(/Modify Global Variable\((afkTerminal|afkSessions|afkStarts|afkEnds), Append To Array, ([^;]+)\);/g,
      (_, key, value) => `captured.${({afkTerminal:'terminal',afkSessions:'session',afkStarts:'start',afkEnds:'end'} as Record<string,string>)[key]}.push(${value});`)
      .replaceAll('Global.roundStart','0').replaceAll('Global.logSession','player.session');
    new Function('state','player','captured',translate(code))(state,player,captured);
  };
  close('AFK return');
  assert.equal(state.closed[1],40); assert.equal(state.open[1],0);
  state.open[1]=110; state.now=130; close('Player leaves');
  state.open[1]=170; state.complete=true; close('Match log');
  assert.deepEqual(captured,{session:[1,1,1],start:[60,110,170],end:[100,130,180],terminal:[0,1,1]});
  assert.equal(state.closed[1],70);
  assert.ok(rule('AFK enter').includes('Global.sessionStatus[Event Player.session] = 2;'));
});
