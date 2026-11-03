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

- **Load:** a full lobby (dummy bots fill empty slots) for one complete
  round on v3.4.1 and on v3.4.2, recording Average and Peak. The readings are
  added to this brief.
- **Log format:** one ranked round on v3.4.2, uploaded through the existing
  importer. It must import exactly like a v3.4.1 log. A copy becomes a parser
  test fixture.
- **Behaviour:** the HUD toggles, the #1 panel, AFK handling and the end
  scene work as before.

## Out of scope

- Anything visible to players beyond the host's optional load display.
- Changes to logging (00) or the conduct rules (03).

## Done when

- Before and after readings are recorded here, and v3.4.2 is no worse on
  Average or Peak.
- A v3.4.2 log imports unchanged and is in the test fixtures.
- v3.4.2 is published on Workshop.codes.

Size: **small**. Ships before [00](00-logging-and-ingest.md).
