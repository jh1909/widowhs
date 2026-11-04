# Ranking

How players are measured today. The current rating is a formula, and is
treated as the seed round for the skill rating (SR) planned in
[brief 01](briefs/01-skill-rating.md), which will replace it.

## Rounds

One uploaded log is one round. The homepage's **Matches played** counts
rounds; a player's match count is their participations. A round's time comes
from its log filename, or the upload time when the filename has none.

The match history (`#/matches`) lists rounds newest first; opening one shows
every participant. Each result keeps the name used in the log, so renames
don't rewrite history.

## Rating

Every round gets a performance score from a fixed formula: 65% kills per
minute, 25% accuracy, 10% K/D, each capped (`supabase/functions/_shared/rating.ts`).
A player's ELO applies the same formula to their averages over their last 100
eligible rounds.

Partial rounds count less. Each round has a weight from 0 to 1:

- **v2 rounds** (script v3.5.0 on) weigh active play: time present minus AFK
  time, as a share of the round. Late joiners, leavers and rejoiners count by
  their active time. Under 30 seconds of active play counts for nothing,
  which drops fully AFK sessions, including the AFK kick. Within 10 seconds
  of the whole round counts fully. Kills per minute is also worked out from
  active time, so AFK periods don't lower it.
- **v1 rounds** only list players present at the end. A round counts fully
  if the player joined within its first 10 seconds or played long or well
  enough, and not at all if they joined late and barely played.

The rule is `match_elo_weight` in
`supabase/migrations/20261103120000_log_ingest.sql` (v2) and
`20261013233000_weighted_elo_participation.sql` (v1), mirrored by
`supabase/functions/_shared/elo-weight.ts`. Only fully counted rounds count
as placements.

A player needs 10 fully counted rounds to appear on the leaderboard. The
leaderboard sorts by ELO, then PB, then name, and ranks are computed over all
qualified players before any search or paging. Banned players are left out.

**PB** is a player's fastest time from joining to 50 kills. The **record
holder** is the fastest PB among all players.

**ELO history** has one point per Berlin calendar day: the average
performance score of that day's eligible rounds. Profiles show it in 30-day
windows.

Matches played, PB, placements and the Veteran badge are lifetime; ELO and
the displayed stats use the last-100 window.

## Badges and medals

Achievements (`src/lib/achievements.ts`): Slayer (K/D), Sharpshooter
(accuracy, three tiers), Veteran (matches played, three tiers), Squat Master
and No Croucher (crouching), Top 10, and Speedrunner (fast 50-kill wins).
Thresholds live in that file and its tests.

Stat medals (`src/lib/stat-medals.ts`) mark the top three values among placed
players for K/D, accuracy, crouches per minute and kills per minute. Players
ranked 1–3 get a podium frame on their profile.

All of these are currently computed in the browser;
[brief 05](briefs/05-badges.md) moves them to the server and adds more.
