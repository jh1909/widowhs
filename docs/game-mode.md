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
Ranked mode, once, when someone reaches the kill target. Since script v3.5.0
it records the round's length and winner, every player session
(including players who left or were kicked) and every kill as a killer and
victim session. Older files (v1) have one line per player still in the
lobby. Script v3.6.0 adds exact times of score gains and losses (format v3),
so rolling-lobby SR can follow actual competition rather than the lobby's age.
[Workshop log format](workshop-log-format.md) describes all versions.

The script keeps each session's stats in global arrays, written in the
existing kill, death, shot, hit, crouch and AFK rules as each counter
changes, so a leaver's stats survive the player leaving. `Player leaves`
closes the session; `Match log` writes the file.

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

Script work in progress: [07](briefs/07-workshop-performance.md) and
[00](briefs/00-logging-and-ingest.md).
