import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { statMedals, medalValue, formatMedalValue, type StatMedalPlayer } from '../src/lib/stat-medals.ts';
import StatMedal from '../src/components/StatMedal.tsx';
import { rankPlayers } from '../supabase/functions/_shared/leaderboard.ts';

const player = (name: string, stats: Partial<StatMedalPlayer> = {}): StatMedalPlayer => ({
  name, elo: 1000, placement_matches: 10, matches: 20, ...stats,
});

test('each stat has independent medals while ELO remains the leaderboard sort', () => {
  const players = [
    player('Alpha', { elo: 2000, kdr: 4, accuracy: '30%', kpm: 5, crouches: 300, time_in_lobby: 600 }),
    player('Bravo', { elo: 1700, kdr: 3, accuracy: '90%', kpm: 15, crouches: 200, time_in_lobby: 600 }),
    player('Charlie', { elo: 1000, kdr: 2, accuracy: '60%', kpm: 25, crouches: 100, time_in_lobby: 600 }),
    player('Delta', { elo: 900, kdr: 1, accuracy: '45%', kpm: 20, crouches: 50, time_in_lobby: 600 }),
  ];
  const copy = structuredClone(players);
  const medals = statMedals(players);
  assert.deepEqual(medals.get('Alpha'), { kdr: 'gold', crouches: 'gold' });
  assert.deepEqual(medals.get('Bravo'), { kdr: 'silver', accuracy: 'gold', crouches: 'silver', pace: 'bronze' });
  assert.deepEqual(medals.get('Charlie'), { kdr: 'bronze', accuracy: 'silver', crouches: 'bronze', pace: 'gold' });
  assert.deepEqual(medals.get('Delta'), { accuracy: 'bronze', pace: 'silver' });
  assert.deepEqual(players, copy);
  assert.deepEqual(rankPlayers(players).map(p => p.name), ['Alpha','Bravo','Charlie','Delta']);
});

test('ties at displayed precision share a tier and subsequent distinct values receive silver and bronze', () => {
  const players = [player('A', { kdr: 4 }), player('B', { kdr: '4.00' }), player('C', { kdr: 3 }),
    player('D', { kdr: 2 }), player('E', { kdr: 1 })];
  for (const input of [players, [...players].reverse()]) {
    const medals = statMedals(input);
    assert.equal(medals.get('A')?.kdr, 'gold');
    assert.equal(medals.get('B')?.kdr, 'gold');
    assert.equal(medals.get('C')?.kdr, 'silver');
    assert.equal(medals.get('D')?.kdr, 'bronze');
    assert.equal(medals.get('E'), undefined);
  }
  const crouchTies = statMedals([
    player('Long', { crouches: 201, time_in_lobby: 600 }),
    player('Short', { crouches: 101, time_in_lobby: 301 }),
  ]);
  assert.equal(crouchTies.get('Long')?.crouches, 'gold');
  assert.equal(crouchTies.get('Short')?.crouches, 'gold');
});

test('crouches use time-weighted rate, not total count or average per match', () => {
  const medals = statMedals([
    player('ManyLongGames', { crouches: 10000, time_in_lobby: 60000 }),
    player('Faster', { crouches: 300, time_in_lobby: 600 }),
    player('Third', { crouches: 100, time_in_lobby: 600 }),
  ]);
  assert.equal(medals.get('Faster')?.crouches, 'gold');
  assert.equal(medals.get('ManyLongGames')?.crouches, 'silver');
  assert.equal(medals.get('Third')?.crouches, 'silver');
  assert.equal(formatMedalValue(player('Rate', { crouches: 300, time_in_lobby: 600 }), 'crouches'), '30.0');
});

test('unplaced or unranked profiles cannot take a medal and invalid/zero stats earn none', () => {
  const medals = statMedals([
    player('Placed', { kdr: 2 }),
    player('Placements', { kdr: 999, placement_matches: 9, matches: 100 }),
    player('NoRating', { kdr: 999, elo: '-' }),
    player('Invalid', { kdr: '-', accuracy: 'NaN%', kpm: Infinity, crouches: 5, time_in_lobby: 0 }),
    player('Zero', { kdr: 0, accuracy: 0, kpm: 0, crouches: 0, time_in_lobby: 60 }),
  ]);
  assert.equal(medals.get('Placed')?.kdr, 'gold');
  assert.equal(medals.size, 1);
  assert.equal(medalValue(player('Empty', { accuracy: '' }), 'accuracy'), null);
  assert.equal(formatMedalValue(player('Empty'), 'pace'), '—');
});

test('search and pagination do not redistribute global medals', () => {
  const players = Array.from({ length: 20 }, (_, index) => player(`Player${index}`, {
    elo: 2000 - index, kpm: index, kdr: 20 - index,
  }));
  const ranked = rankPlayers(players);
  const medals = statMedals(ranked);
  const secondPage = ranked.slice(10);
  assert.equal(medals.get(secondPage.at(-1)!.name)?.pace, 'gold');
  assert.equal(medals.get(ranked.filter(p => p.name === 'Player5')[0].name)?.kdr, undefined);
  assert.equal(medals.get(ranked.filter(p => p.name === 'Player2')[0].name)?.kdr, 'bronze');
});

test('medals expose colour, tier and category accessibly and missing medals render nothing', () => {
  const markup = renderToStaticMarkup(createElement(StatMedal, { tier: 'gold', category: 'accuracy', value: '60.00%' }));
  assert.match(markup, /aria-label="Gold medal · Accuracy: 60.00%"/);
  assert.match(markup, /stat-medal--gold/);
  assert.match(markup, />1<\/text>/);
  assert.equal(renderToStaticMarkup(createElement(StatMedal, { category: 'kdr', value: '2.00' })), '');
});
