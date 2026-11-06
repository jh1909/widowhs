# 05 · Badges

## Goal

Make badges visible, fun and motivating: a public catalogue, joke badges,
badges that reward playing strong lobbies, and a badge players can pin to
their profile header.

## Today

Seven achievements (Slayer, Sharpshooter, Veteran, Squat Master, No Croucher,
Top 10, Speedrunner) and the stat medals are computed in the browser
(`src/lib/achievements.ts`, `src/lib/stat-medals.ts`; see
[ranking](../ranking.md#badges-and-medals)). There is no list of all badges.

## Decisions

- **Badges are public.** No secret badges. Every badge, its criteria and
  tiers are listed.
- **Computed server-side** into a player badges table (badge, tier, count,
  first earned, currently held), updated on import. Existing achievements and
  stat medals move there; the website only displays them.
- **Two kinds:**
  - *Current*: held while the condition is true, can be lost (Top 10,
    Sharpshooter, Slayer, lobby and variance badges).
  - *Lifetime*: earned once, kept, with a count where it repeats (Veteran,
    Speedrunner, single-round feats).

## Catalogue

A Badges page (`#/badges`) lists every badge with its icon, criteria, tiers,
kind and how many players hold it. Each badge links to its holders.

## New badges

Joke badges, lifetime, earned from a single round with at least 2 minutes
played:

| Badge | Criteria |
|---|---|
| **Stormtrooper** | Accuracy under 10% in a round |
| **Leg Day** | 300 or more crouches in a round |
| **Photo Finish** | Won a round by exactly one kill (lifetime count) |

Starting thresholds are checked against history at backfill and set so each
joke badge goes to roughly the top 1% of rounds.

Variance badges, current, from each player's last 100 rated rounds (at least
60). Round performance is SR's actual minus expected kill share
([01](01-skill-rating.md)). Spread is the gap between the average of the
player's top 5% and bottom 5% of rounds.

| Badge | Criteria |
|---|---|
| **Wildcard** | Widest spread: top 10% of placed players |
| **Metronome** | Narrowest spread: bottom 10% of placed players |

Lobby badges, current, from the last 100 rated rounds: the average gap between
the lobby's strength (excluding the player) and the player's own SR at the
time.

| Badge | Criteria |
|---|---|
| **Deep End** | Lobbies average at least 100 SR above the player |
| **Shallow End** | Lobbies average at least 150 SR below the player |

Thresholds for variance and lobby badges are confirmed after the SR backfill
so each goes to a meaningful minority. Badge names can be changed at review.

## Pinned badge

- A player picks one badge they currently hold; it shows in their profile
  header next to their name.
- Stored with the profile details. The server checks the player holds it.
- If a current badge is lost, the pin is hidden until it is earned again.
- Any badge can be pinned, joke badges included.

## Phasing

1. Server-side badges, catalogue, joke badges and pinning. No SR needed.
2. Variance and lobby badges after [01](01-skill-rating.md) launches.

## Done when

- Badges on profiles match the old browser-computed ones after migration.
- The catalogue lists every badge with correct holder counts.
- Joke badges are backfilled from history.
- A player can pin and unpin a badge; a lost current badge disappears from
  the header.
- After SR: variance and lobby badges are awarded and their thresholds
  recorded here.

Size: **medium**.
