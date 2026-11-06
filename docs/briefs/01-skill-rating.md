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
  - Kicked sessions (the existing ranked AFK kick) count only their active
    time, as in today's ELO ([00](00-logging-and-ingest.md)): a fully idle
    one is under 30 s and excluded.
- **Noise rounds.** AFK and messing-about rounds are excused in three layers,
  for everyone alike:
  1. Each pair's surprise (actual minus expected share) is capped, about
     ±0.25. One freak round, good or bad, can only move a rating so far. The
     cap is symmetric, so pairs stay zero-sum.
  2. From v2 logs: AFK time is subtracted from time present, and sessions with
     almost no shots per minute count as not playing and are excluded,
     both ways. These judge effort, not score.
     In v3 an actual positive score change proves effort even if an earlier
     quiet period lowered the session-wide shot rate. Scoreless sessions use
     the absolute `rollingMinShots` effort floor, so earlier waiting cannot
     exclude a genuine zero-score participant. The active-time cutoff still applies.
  3. Kicked sessions keep only their active time, so a fully idle one is
     excluded (the existing ranked AFK kick).
  Excusing each player's worst rounds by score is ruled out: it would hide
  real slumps, and unless opponents' wins were dropped too it would inflate
  every rating.
- **Update.** A player's change is their K (from their uncertainty) times the
  weighted sum of `(S − E)` over opponents. Small lobbies carry less evidence
  for both gains/losses and uncertainty, so they also contribute more slowly
  to placement. The curve and its anchors live in `DEFAULT_SR_PARAMS.settings.lobbySize`
  in [`sr.ts`](../../supabase/functions/_shared/sr.ts); tests pin the agreed shape.
  A smooth power curve goes through the lower player-count/weight anchor and
  reaches the upper player-count/weight anchor, then stays at that ceiling.
  Below the lower player count, play is unrated. The low-end weight is an
  anchor, not a hard floor clamped onto the curve.
  For older logs the weight is integrated over concurrent session periods.
- **Rolling lobbies (v3 logs).** Exact score-change times replace elapsed time
  as the evidence clock. Every scoring player is compared with all eligible
  opponents present at that event, regardless of the victim. The size curve
  discounts the scoring outcomes and evidence from small lobbies. Waiting
  adds nothing, and a late joiner never inherits earlier scoring or a fraction
  based on the lobby's age. Environmental losses reduce shared scoring, but
  never manufacture extra positive observations.
  Each positive event contributes one observation spread over the current
  opponents. A full evidence budget is controlled by `rollingEvidenceKills`.
  Pair evidence is divided by the larger of the two players' observation
  budgets (or one if neither is full), so no player exceeds one full round's
  budget and opponent replacements cannot multiply it. This symmetric cap
  can reduce a pair's evidence if either player already has substantial play
  elsewhere in that round. This depends on scoring, never the time spent waiting.
  Tiny low-scoring periods supply little evidence; a fast substantial contest
  can count normally. The winner bonus is still applied once per pair, and
  all SR updates use pre-round ratings, not intermediate event-by-event SR.
- **Older-log fallback** (reference: `supabase/functions/_shared/sr.ts`):
  participants are rated in the order the database supplies them (first
  `player_matches.id` in the round), so a rename never changes a result. Time
  present means active time (present − AFK) for the cutoff and the
  weight. Both players' kills are pro-rated to the time they shared
  (kills × overlap ÷ own time present; for v1 only the longer-present
  player's change). Each pair's weight integrates the lobby curve and opponent
  normalisation over its shared periods, then applies the existing active-time
  cap. AFK logs contain a duration, not AFK start/end times: partially AFK
  sessions retain that cap rather than inventing an AFK timeline. Fully idle
  and effort-excluded participants do not contribute to the lobby size.
  Pairs that never shared the lobby, or only shared below-cutoff periods, are skipped.
  Expected uses Glicko's g(opponent uncertainty). A player whose pairs were
  all 0–0 is not rated that round. The match dialog's expected and actual
  share are the player's pairwise E and S averaged over their pairs,
  weighted as in the update.
  Event weight and cumulative rated weight include the size curve and active
  participation. Full-round counts still describe active attendance, not
  placement evidence; placement is determined by uncertainty.
- **Lobby strength** is stored per round: time-weighted mean SR of the
  participants, with lowest and highest.
- **Starting point.** Replay all history in `played_at` order from a default
  rating. A seed from the formula ELO predicted only marginally better in
  the backtest, so SR starts from the default and owes nothing to the
  retired formula.
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

### Original size-neutral backtest (4 November 2026)

`scripts/sr-backtest.ts` replays the 4 November production backup: 3,713 v1
rounds from 11 October to 4 November, assembled as the database does (one
malformed batch round skipped, Battle.net-name rows re-pointed to their
profiles, time present capped at the round length).

- **Method:** settings are chosen on the first 70% of rounds only. The
  last 30% (from 28 October; 9,054 pairs) is scored once, after the choice
  is frozen. Ratings run through the split. Scored pairs are those where
  both players had 10 earlier rated rounds and 5 formula scores. The score
  is the weighted log-loss of the predicted pairwise share against the
  actual pro-rated kill share, without the winner's bonus. Each model's
  prediction goes through a logistic scale fitted on the tuning rounds, so
  raw and logistic curves and the formula ELO (mean of the last 100 round
  scores) compare fairly. Stability is measured on established players: SR
  range over their last 20 rounds, worst fall over 8 rounds, and how many
  placed players change side of the median cautious SR in a week. For the
  choice it is measured on the second half of the tuning period (from
  19 October; the first half is warm-up).
- **Chosen:** raw kill share, β = 0.05, D = 400, m = 5, uncertainty 160 for
  a new player with a floor of 50, cap ±0.25, default start (values in
  the version 1 parameters, before lobby-size weighting). This is the best
  tuning-period predictor whose stability there is no worse than the
  prototype setting's (D = 400, m = 5, 350/50, 90th percentiles within 5%).
  The raw curve beat every logistic scale. β = 0 predicted marginally
  better, so β sits at the 0.05 floor. The choice is in effect the
  prototype with a lower starting uncertainty, a smaller bonus and the cap.
  A faster family (D = 300, m = 12, floor 30) predicted better on the tuning
  period but missed the stability gate narrowly (8-round fall, 90th
  percentile 19.2 against a limit of 18.8).
- **Prediction (held out):** log-loss 0.6547 against 0.6564 for the formula
  ELO (paired bootstrap over rounds: −0.0017, 95% interval −0.0027 to
  −0.0012), and level with the prototype setting (0.6546; +0.0000, −0.0002
  to +0.0002). Kill order is right 82.3% of the time, against 81.9% for the
  formula ELO and 82.1% for the prototype.
- **Stability (held out):** an established player's 20-round range has
  median 18 SR (90th percentile 31). The worst 8-round fall has median 5 and
  90th percentile 23 (largest 44, against 50 for the prototype). In a
  typical week 16 placed players (7.3%) cross the median, against 7.6% for
  the prototype. The best predictor overall (D = 500, m = 12, floor 70)
  gains 0.0019 but more than doubles the range (51/79), so it was rejected.
- **Cap:** dropping the ±0.25 cap would gain 0.0004 in log-loss. It is kept
  as the guard against freak rounds, which are too rare to show in the
  score; it also bounds one round's move for an established player to about
  17 SR.
- **Start:** a seed from the formula ELO as of 28 October (`player_history`,
  so nothing from the scored period) predicts 0.0007 better than the default
  start, with uncertainty 100. A two-pass start does the same but uses the
  future. The gain is too small to justify a frozen seed table and a
  mapping from the formula's scale, so the default start is used.
- **Placement:** a player is placed once their uncertainty is no more than
  it would be after 6 ideal rounds (full weight, even odds, established
  opponents; 59.6). Real rounds carry less information, so on the tuning
  period this places a typical player after 10 rated rounds (10th to 90th
  percentile 8 to 13), as the brief intends; requiring the floor (50) took
  14.
- **Strong player in a weak lobby:** at the 99th against the 10th percentile
  of placed SR (1,713 against 1,434), winning 50 to 10 gains under 1 SR and
  50 to 20 costs about 7 SR.
- **Impact:** placed players' SR runs from 1,332 to 1,713 (1st to 99th
  percentile). Over all history players place after a median of 10 rated
  rounds (8 to 13), and 6 formula-placed players are not yet placed. Rank
  correlation with the current leaderboard is 0.97 across 390 placed
  players. Two of the top five and 7 of the top 10 stay. The 30 biggest
  risers have many rounds (median 48 placements against 18 overall). The 30
  biggest fallers have few (median 12), so a wide range lowers their
  cautious SR, and lean on accuracy (36% against 32%) and kills per minute
  (6.8 against 5.5), which the formula rewards but which did not win them a
  larger share of the kills. The mean SR of active players settles near
  1,492 and rose 0.9 SR over the last two weeks.

### Lobby-size weighting comparison (4 November 2026)

`scripts/sr-backtest.ts DUMP OUTDIR lobby` compares the original size-neutral
settings with the agreed curve, using the same historical v1 backup and split.
This is a product-policy comparison with frozen settings, not another search
on the held-out data. The original prototype/sweep remains size-neutral for
reproducibility. The script also assembles v2 sessions and v3 scoring histories
and evaluates exact shared kill totals when available. Input-assembly tests
cover all versions, alias resolution, rejoins and missing-history rejection.

- Held-out log-loss changes from 0.6547 to 0.6545, and kill-order accuracy from
  82.33% to 82.29%. These are descriptive results, not evidence of a significant
  prediction improvement.
- The median rounds to placement remains 10; the 10th–90th percentile interval
  changes from 8–13 to 8–14. Established players' median 20-round SR range
  changes from 17.9 to 18.7. The final placed count changes from 458 to 469:
  replay changes opponents' uncertainty and subsequent results throughout history,
  so a lower weight does not guarantee fewer placed players in aggregate.
- Reports break prediction scores down by mean concurrent eligible size
  (scoring-weighted for v3, time-weighted for old logs). Only 16 held-out
  established pairs fell in the smallest concurrent-size group, so this backup cannot establish
  small-lobby prediction quality. Tests separately verify the intended discount,
  time integration, slower duel placements, exclusion rules and both engine ports.

The four `lobbySize` fields are versioned data in `rating_params.settings`.
Changing the low-end weight changes the derived exponent smoothly; changing
the player-count anchors moves the cutoff/ceiling; `fullWeight` scales the
ceiling. Create a new parameter version, deactivate the previous version and
activate the new one in one transaction. Existing hooks re-rate all history.
No engine or Workshop change is needed to retune these fields. Version 1 is
retained for a size-neutral comparison or rollback.

### Rolling-lobby evidence (v3 logs)

Parameter version 3 adds scoring-based evidence for timestamped logs. The
full-round observation target lives in `rollingEvidenceKills`; it is an
explicit policy setting, not fitted on timestamped production data. Such
data does not exist in the historical backup. On that backup version 3 gives
the same results as version 2, because it uses the documented time fallback.
This validates fallback continuity, not the new model's predictive accuracy.

Regression fixtures cover a four-minute full lobby after thirty minutes of
waiting, a resident who waited without entering the AFK state, and stretching
the same early duel from three minutes to thirty. These leave equivalent
shared scoring unchanged. Additional tests cover low-volume late joins,
fast wins, opponent replacements, score losses and the evidence ceiling.
The SQL/reference suite includes randomized timestamped cases and v3 imports
through the actual parser/import/replay path, including corrections,
identity changes, moderation and retuning.

Once timestamped production data accumulates, rerun the backtest before
changing the observation target on prediction grounds. The lobby curve and
observation target remain independent, versioned settings.

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

### Exact AFK intervals (v4 logs)

Format v4 removes phased AFK periods from each event's opponents and eligible
lobby size, preserving shared scoring before and after every break. Active
eligibility still subtracts raw AFK duration once. V4 duration comes from the
session facts, so correcting or removing a break also corrects eligibility;
legacy attendance assembly is unchanged. Returns include their endpoint;
terminal closures remain AFK through their endpoint, including zero-duration
AFK at the win. No timestamp epsilon is used.

The configured time-model fallback integrates the complements of known AFK
periods. Historical NULL timing retains its existing cap rather than inventing
intervals. Backtests carry v4 breaks explicitly and use the same endpoint
policy. The new SR migration follows the v4 data migration; no rating parameter
version or scoring formula changes. Local regressions cover actual
log/import/SQL/reference equivalence between leaving and remaining AFK, replay,
terminal endpoints and fallback. Workshop syntax, scheduling races and load
remain pending in-game checks.
