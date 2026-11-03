# Game mode

## The mode

Widow HS is a free-for-all Overwatch custom game: Widowmaker only, scoped
headshots only, first to 50 kills. Respawns are instant, a kill restores
full health, and the script removes damage falloff at long range. Players
idle for 15 seconds are moved to an AFK state; in Ranked mode they are
removed after a further 60 seconds.

The script is published on Workshop.codes as
[Widow HS 2.0](https://workshop.codes/widowhs), share code `TCG2W`.
Workshop.codes is its canonical home; changes are published there by its
author. A copy lives in `workshop/widowhs.ows` so changes are reviewed as
diffs; the author pastes it into the Workshop editor to publish. Lobby
settings include HP, custom spawns, disabling crouching, the kill target,
endless mode and **Ranked mode**, which forces 175 HP and writes the match
log. Two **Testing** settings, both off by default, show the host the server
load and fill empty slots with bots (never in Ranked mode).

## The match log

The log is the contract between the game and the site. It is written only in
Ranked mode, once, when someone reaches the kill target: one line per player
still in the lobby. Players who left earlier are not recorded
([brief 00](briefs/00-logging-and-ingest.md) changes this).

```text
[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271
```

Columns: player, kills, deaths, accuracy (%), kills per minute, K/D,
crouches, time in lobby, total match time. Times are whole seconds. Time in
lobby runs from when the player joined; total match time is the round's
length. Older files have eight columns and no match time.

Overwatch names the file `Log-YYYY-MM-DD-HH-MM-SS.txt`; the site reads the
match time from it as Berlin time. One file is one round.

The parser (`supabase/functions/upload-csv/parser.ts`) rejects a whole file
if any line doesn't fit. Change the script's log output and the parser
together, and deploy the parser first.

## Performance

Workshop lobbies are shut down when server load stays high. When changing the
script:

- Keep the server load average under about 80 and peaks under 100. Measure in
  a full lobby before and after a change.
- Add to existing event rules rather than new `Ongoing - Each Player` rules:
  each of those runs once per player, twelve times in a full lobby.
- Prefer conditions to actions, and avoid line-of-sight checks.
- Keep per-player loops short; once a second is enough for stats.
- Stay well inside the 128 text elements allowed across all players: use
  shared HUD texts and messages instead of new per-player texts.
- Keep Inspector recording off during the round; turn it on only to write
  the log at match end.

Planned script work: [07](briefs/07-workshop-performance.md) and
[00](briefs/00-logging-and-ingest.md).
