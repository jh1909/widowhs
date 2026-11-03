# 03 · Conduct rules

## Goal

Remove players who are only there to obstruct others. Dodging, pressure and
poor play are allowed; the rules target clear troll behaviour only.

## Basis

- The Workshop can read scope state, movement input, shots and kills, show
  messages to one player or the whole server, and remove players
  (`Remove Player`, already used by the ranked AFK kick).
- Unscoped shots are impossible in the mode.
- Charge, from Liquipedia's current Widowmaker values (scoped damage 12–125,
  2.5× headshot, 0.9 s to full charge, no perks in this mode) at the ranked
  175 HP. Times are approximate; see shot classification below:

| Charge | Time scoped | Headshot damage | Headshots to kill | Treatment |
|---|---|---|---|---|
| Under 20% | under ~0.18 s | under 87.5 | 3 or more | Low-charge (troll) shot |
| 20–51% | ~0.18–0.46 s | 87.5–175 | 2 | Allowed ("two halves") |
| Over 51% | over ~0.46 s | 175+ | 1 | Normal shot |

How a shot is classified:

- **Hits** are classified by damage, which is exact: a headshot under
  87.5 damage (after the script's own falloff correction) cannot kill in two
  shots at 175 HP, so it is a low-charge shot. This needs no charge-time
  figure.
- **Misses** are classified by time scoped since scoping in or since the last
  shot. Sources disagree on the charge time (0.75–1 s) and on whether the
  ~0.3 s scope-in animation counts towards charge, so the cut-off is a
  Workshop setting. It is set from a calibration run before the trial week:
  shots at a dummy bot at known hold times, reading the damage. Until
  calibrated, the default is 0.18 s plus the scope-in time, which errs
  towards leniency.

All rules run live in the Workshop from game events, not sampled: shot
timestamps for Spammers, time since the last shot for Walkers, and scoped vs
unscoped time accumulated from scope-in and scope-out for Opportunistic
walkers.

## Rules

| Rule | Trigger | First offence | Second offence |
|---|---|---|---|
| **Opportunistic walkers** | Moving and unscoped ≥ 85% of a 30 s window, no kill | Forced AFK with a custom warning | Kick |
| **Walkers** | Moving for 20 s with no shots, no kill | Forced AFK with a custom warning | Kick |
| **Spammers** | 15 low-charge shots in any 20 s window | Warning, then an 8 s rate check | Kick if 6 or more low-charge shots in those 8 s |

- **One strike per round, shared by all three rules.** The first offence of
  any rule is the warning; any later offence in the same round is a kick.
  The Spammers rate check is that rule's immediate second offence.
- **Forced AFK** reuses the existing AFK state with the rule's own message.
  The player must stay in it at least 5 s before moving returns them. The
  existing ranked rule still kicks anyone who stays AFK for 60 s.
- **What clears timers:** a kill clears all of them. A shot at 20% charge or
  more clears the Walkers and Spammers timers. Five seconds of scoped play
  clears the Opportunistic walkers window. A cleared timer does not clear a
  strike.
- **Death does not reset timers.** Time only counts while alive, but adds up
  across lives, so a player who dies every few seconds is still caught.
- **Ignored time:** the first 2 s after each spawn, the pre-game, the end
  scene and time in AFK.
- **Re-kick:** kicked names go on a list for the round. Anyone joining under
  one of those names is removed straight away until the round ends. The list
  is cleared at match start. This matches by display name; the small risk of
  removing someone with the same name for the rest of that round is accepted.
  The list is needed because `Remove Player` does not stop a rejoin: the
  game treats a rejoining player as new. Global variables reset on
  `Restart Match` (the current script relies on this: `gameComplete` is never
  set back to false), so the list ends with the round by itself; clearing it
  at match start is a safeguard.

## Performance

Follows the [Workshop performance principles](../game-mode.md#performance).
Specifically:

- Low-charge shot timestamps are recorded and pruned inside the existing shot
  rule; Walkers and Opportunistic walkers are checked in the existing
  once-a-second `Per player timer` loop. The only new continuous rule is a
  scope in/out counter, shaped like the existing crouch counter.
- Warnings use `Small Message` / `Big Message` or reuse the AFK text slot,
  since a full lobby already uses roughly 50–80 of the 128 text elements.

## Visibility

- Warnings and countdowns: shown to the player only, naming the rule and
  saying the next offence is a kick.
- Kicks and re-kicks: announced to the whole server, e.g. "X was removed
  (Walkers)".

## Where it applies

Ranked mode only, like the existing AFK kick and match logging. Casual
lobbies running the script are unaffected.

## Logging and site

- Every forced AFK, warning, kick and re-kick is written as a `#C` line at
  match end ([00](00-logging-and-ingest.md)).
- Kicked sessions are excluded from SR ([01](01-skill-rating.md)) and
  statistics for the kicked player. Others in the round are rated as usual.
- Admin shows conduct events per player and per round. They are not public.

## Rollout

This brief can ship before [00](00-logging-and-ingest.md) is complete:

1. The importer skips lines starting with `#` (a small change that 00's
   parser keeps). Deployed before the new script is published.
2. Publish the script with a **Conduct kicks** Workshop setting, off by
   default. While off, rules detect and show the private warning only: no
   forced AFK, no kicks. Every detection is still written as a `#C` line.
3. Run for one week, then review the `#C` lines in the host's log files.
   Adjust thresholds if legitimate play was caught.
4. The host turns Conduct kicks on. No republish is needed.

Once 00's tables exist, `#C` lines are stored as conduct events.

## Out of scope

- Permanent bans. The Workshop keeps nothing between matches; the site's
  existing ban covers the leaderboard only.
- Detection of cheating or exploits.

## Done when

- Each rule triggers in a private test lobby at its thresholds, and not for
  normal play, two-halves play or a player dying repeatedly while scoping.
- The trial week shows no warnings on players reviewed as legitimate.
- Kicks, re-kicks and announcements work, and every event appears in Admin.

Size: **medium**, mostly Workshop work.
