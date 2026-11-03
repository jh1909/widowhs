# 07 · Workshop performance

## Goal

Measure the Workshop script's server load and take the easy savings before
[00](00-logging-and-ingest.md) and [03](03-conduct.md) add tracking. Nothing
changes for players, and the match log format stays exactly as it is, so the
site needs no change.

## Basis

The [Workshop performance principles](../game-mode.md#performance) set the
targets. The Workshop exposes Server Load, plus Average and Peak over the
last 2 seconds.

The current script (v3.4.1) has eight `Ongoing - Each Player` rules (96
instances in a full lobby), uses roughly 50–80 text elements, and does no
line-of-sight checks. The spawn calculation measures distances from every
spawn point but only runs on respawn, so it is left alone.

## Changes (v3.4.2)

1. **Show server load** Workshop setting, off by default. When on, the host
   sees Server Load, Average and Peak. Added first, so the baseline is
   measured on otherwise unchanged code.
2. **One shared "#1 Accuracy / Kills per min" panel.** Today each player with
   the big HUD has their own copy. One global HUD text, visible only to those
   players, uses one text ID and one evaluation.
3. **Top accuracy and top kills per minute recomputed once a second** in one
   global loop. Today the top-accuracy check runs on every shot and scans all
   players whenever the leader shoots.
4. **Optional:** move per-player time formatting into the same global loop.
   Kept only if the readings show a gain.

## Where the code lives

The v3.4.1 script is added to the repo as `workshop/widowhs.ows` on a branch,
and each change above is its own commit, so changes are reviewed as diffs.
Workshop.codes stays the published home: Klog pastes the result into the
Workshop editor and publishes. 00's Workshop changes build on this branch.

## Testing

The script has two Testing settings, both off by default: **Show server
load** and **Fill empty slots with bots**. Bots move, aim at a random living
player, fire about once every three seconds and use the big HUD, the worst
case for per-player texts. They are never added in Ranked mode.

- **Load:** with both settings on, one complete round on the baseline
  (commit "host server load display and test bots", v3.4.1 behaviour) and
  one on v3.4.2, on the same map, recording Average and Peak. Note the lobby
  size: the script does not set Max FFA Players, so the lobby's own limit
  applies.
- **Log format:** one ranked round on v3.4.2, uploaded through the existing
  importer. It must import exactly like a v3.4.1 log. A copy becomes a parser
  test fixture.
- **Behaviour:** the HUD toggles, the #1 panel, AFK handling and the end
  scene work as before.

## Readings

One round each on Necropolis, 12 players (11 bots and the host), Ranked
off, readings by eye from the host's load display. Server ping is noted
because the game server varies between lobbies.

| Version | Server | Average | Peak |
|---|---|---|---|
| Baseline | 160 ms | 30–40 | Mostly 60–80; 108 mid-match, about 115 after the win |
| v3.4.2 | 160 ms | 20–40 | Up to about 70, a few in the 90s; highest 99, mid-match |
| v3.4.2 | 115 ms | 30–50 | Up to about 110 mid-match |
| v3.4.2 | 60 ms | 50–70 | Often 120–150, once about 210 |
| v3.4.2, final | 160 ms | 20–40 | Rarely above 80, at times down to 30–40 |
| v3.4.2, final | 60 ms | High | Never below 100 |

"v3.4.2, final" adds a stored list of big-HUD players for the shared panel.

On the 160 ms server, the only one measured on both versions, v3.4.2 is no
worse on Average and its peaks were lower: usually at or below about 80 for
the final version, against spikes of 108 and 115 on the baseline. No exact
maximum was recorded for the final version. On the 60 ms server v3.4.2
still peaked above 100 throughout; there is no baseline there, so it shows
that load varies more between servers than between versions, not how the
versions compare. Ranked mode was not measured: bots are off in Ranked, and
Ranked adds logging at the win.

## Out of scope

- Anything visible to players beyond the host's optional load display.
- Changes to logging (00) or the conduct rules (03).

## Done when

- Before and after readings are recorded here, and v3.4.2 is no worse on
  Average or Peak.
- A v3.4.2 log imports unchanged and is in the test fixtures.
- v3.4.2 is published on Workshop.codes.

Size: **small**. Ships before [00](00-logging-and-ingest.md).
