# 01 · Skill rating (SR)

## Goal

Replace the current formula ELO with a real skill rating: each player's rating
predicts how they should do against a given lobby, and moves by how they
actually did. Kills are the measure, as progress towards the 50-kill win;
winning carries a small extra reward.

## Today

The current "ELO" is a formula over the last 100 eligible rounds: 65% kills
per minute, 25% accuracy, 10% K/D ([ranking](../ranking.md#rating)). It
ignores who else was in the lobby, and 35% of it rests on accuracy and K/D,
which do not decide games.
It served as the seed round and ends when SR launches.

## Decisions

- **Name:** SR. The formula ELO is retired and its history kept, labelled
  "Seed round".
- **Only kills and the win count.** Deaths, accuracy and kills/min play no
  part in SR. They stay on profiles as statistics.
- **Pairwise kill share.** Every pair of players in a round is a mini-match.
  A player's result against an opponent is their share of the kills between
  the two: 45 vs 30 is 0.60, 49 vs 50 is 0.495. Pairs where both have 0 kills
  are skipped.
- **Expected share** comes from the rating gap, Elo-style:
  `E = 1 / (1 + 10^(−(Rᵢ − Rⱼ) / D))`.
- **Winner's bonus.** In every pair involving the winner, the winner's share
  becomes `S + β(1 − S)`, the opponent's `1 − that`. β starts at 0.1.
  Small wins gain most (50 vs 49: 0.505 → 0.554), large wins least
  (50 vs 10: 0.833 → 0.850), and a bigger win always scores more. Each pair
  stays zero-sum, so the bonus redistributes rating rather than inflating it.
- **Uncertainty.** Each player has a rating and an uncertainty (Glicko-style).
  New players move fast; established players move little from games against
  unknowns. This also stops newcomers who lose and quit from inflating the
  regulars.
- **Participation.**
  - Under 30 s in the round: excluded entirely, for themselves and as an
    opponent.
  - From 30 s: weight = time present ÷ round length, capped at 1. Kills do not
    affect the weight.
  - When two players were present for different times, the longer-present
    player's kills are pro-rated to the overlap. From v2 rounds the overlap is
    exact (session start and end, [00](00-logging-and-ingest.md)).
  - Leavers from v2 rounds count like anyone else, by their time present.
  - Kicked sessions (the existing ranked AFK kick) are excluded.
- **Noise rounds.** AFK and messing-about rounds are excused in three layers,
  for everyone alike:
  1. Each pair's surprise (actual minus expected share) is capped, about
     ±0.25. One freak round, good or bad, can only move a rating so far. The
     cap is symmetric, so pairs stay zero-sum.
  2. From v2 logs: AFK time is subtracted from time present, and sessions with
     almost no shots per minute count as not playing and are excluded,
     both ways. These judge effort, not score.
  3. Kicked sessions are excluded (the existing ranked AFK kick).
  Excusing each player's worst rounds by score is ruled out: it would hide
  real slumps, and unless opponents' wins were dropped too it would inflate
  every rating.
- **Update.** A player's change is their K (from their uncertainty) times the
  weighted sum of `(S − E)` over opponents, normalised so lobby size does not
  change how much one round can move a rating.
- **Lobby strength** is stored per round: time-weighted mean SR of the
  participants, with lowest and highest.
- **Starting point.** Replay all history in `played_at` order from a default
  rating. A variant seeded from the formula ELO is backtested; the better
  predictor is used.
- **Leaderboard** ranks by the cautious value, SR minus twice the uncertainty.
  A player is placed once their uncertainty falls below the level reached
  after about 10 full-weight rounds. Profiles show SR with its range.
- **Rollout.** SR runs hidden alongside the formula ELO, then both are shown,
  then SR replaces it with an "end of seed round" announcement.

## Tuning by backtest

A replay script runs every stored round in order and scores how well
pre-round ratings predict each round's kill shares. Compared variants:

- share curve: raw kill share vs a logistic curve on the kill difference
- β for the winner's bonus (0 to 0.2)
- D, K range and uncertainty settings
- default start vs formula-ELO seed
- the formula ELO itself, as the baseline

Chosen: the best-predicting combination, with β at no less than 0.05 so a win
always means something. The script also reports the mean SR of active players
over time; drift is handled by [02](02-rating-decay.md).

Stress tests, each a fixture in the test suite:

- eleven players on 49, winner on 50: the winner's gain is small
- top three within 5 kills, fourth 15–20 behind: fourth loses to all three
- a strong player in a weak lobby gains almost nothing for winning
- a late joiner at 45 s counts for little; at 20 s not at all
- tied kills, 0–0 pairs, two-player lobbies, a round with a rejoin

### First prototype run (3 November 2026)

`scripts/sr-prototype.py` replays the 30 October production backup
(3,015 rounds) with untuned settings; usage is in its header. Starting
reference for the real backtest:

- **Prediction:** SR orders established players by kills correctly 81.1–81.5%
  of the time, against 80.9% for the formula ELO on the same pairs. The
  winner's bonus (β = 0.1) improved prediction slightly in every setting.
- **Impact:** rank correlation with the current leaderboard is 0.94 across 319
  placed players. The top five barely change. Risers tend to take a large
  share of kills with modest accuracy and K/D; fallers lean on accuracy and
  K/D, or have few placement rounds and so a wide range.
- **Responsivity:** the most predictive setting (`M = 12`) let eight poor
  rounds take a player who won most of their earlier rounds below average.
  `M = 5` predicts almost as well (81.1%) and is calmer. The backtest should
  weigh stability for players, not only prediction.
- **Noise:** about 3% of rounds over 30 s are under half a kill per minute.
  Capping each pair's surprise at ±0.25 (`--clip=0.25`) kept prediction at
  81.6% and lifted a player whose slump was mostly near-zero rounds from
  151st to 111th. Dropping rounds under 0.5 kills/min (`--skim=0.5`) did
  about the same but also discards genuine weak rounds from new players, so
  it waits for the effort signals in v2 logs.
- **Cold start:** everyone starts at 1,500, and uncertainty reaches its
  minimum after about ten rounds. Players who played mostly in the first
  weeks beat opponents still rated near 1,500 and then gained only a few
  points per win, so their SR was still climbing when they stopped. Starting
  each player from a first-pass rating (`--twopass`) moved one such player
  from 109th to 57th. The backtest should compare seeded starts and a slower
  shrinking of uncertainty.

## Engineering

- SR depends on order, so any change to history recomputes every later
  rating: renames and merges, bans, deletions, and uploads with an earlier
  `played_at` than rounds already rated. The rating job replays from the
  earliest affected round, under the same lock as imports.
- New tables: current SR per player, and per-round before/after SR, expected
  and actual share, and lobby strength.
- Computation runs in the database (or a job writing to it), not in the
  browser.
- UI: SR and range on the profile and leaderboard; on the match dialog, each
  player's expected vs actual share ("expected 41% of the kills against this
  lobby, took 48%"); SR history continuing on from the seed-round chart.
- Tests run in the existing PGlite setup.

## Out of scope

- Matchmaking. Lobbies stay open; SR limits what easy lobbies are worth but
  cannot stop players choosing them.
- Inactivity handling: [02](02-rating-decay.md).

## Done when

- The backtest report shows the chosen settings predict kill shares better
  than the formula ELO, and all stress tests pass.
- Replaying from scratch gives the same ratings as incremental updates.
- Every kind of history change triggers a correct replay.
- SR is live on profile, leaderboard and match dialog, and the seed round is
  closed and labelled.

Size: **large**.
