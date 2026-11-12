# 00 · Logging and ingest pipeline

## Goal

Record everything later briefs need, once, in one Workshop update, and turn
raw logs into clean rounds before they reach the website. The website only
displays results ([target data flow](../architecture.md#proposed)).

## Today

- The Workshop logs one row per player still in the lobby when someone
  reaches the kill target. Players who left earlier are not recorded at all.
- No winner, no kill events, no scope or shot detail, no slot.
- Logs are uploaded by hand. The parser rejects the whole upload if any line
  is not 8 or 9 columns.
- Nothing stores the raw file; re-uploading the same file imports it twice
  unless an admin notices.

## Decisions

- **Active-time display and PBs.** The HUD timer and KPM pause during AFK,
  and AFK players are restored for the end scene. The v3 log contract stays
  intact. PBs use the actual winning session minus its AFK time, so summed
  rejoin scores cannot create false wins. Legacy PBs retain recorded time.
  `20261105120000_active_time_personal_bests.sql` backfills the database;
  [deployment and in-game checks](../development.md#deployment) remain required.
- **Timestamped scoring (v3).** Workshop v3.6.0 adds cumulative score changes
  per session, including environmental losses. See [the v3 contract](../workshop-log-format.md#v3).
  This lets SR compare actual shared scoring in a rolling lobby without
  treating earlier waiting time as participation. v1/v2 stay supported, with
  explicitly unknown score timing. Parser/database tests cover the contract;
  v3.6.0 still needs in-game syntax, cutoff ordering and server-load validation
  before publication. The earlier v3.5.0 in-game results do not validate v3.6.0.
- **New log format (v2), marked by a version line.** Files without it are
  parsed as today (v1). Both are supported indefinitely.
- **Every player session is logged**, including leavers and kicked players,
  with kills gained during that session so rejoin sessions can be summed.
- **Kill pairs** are logged per round from the first v2 round onwards. Older
  rounds cannot be backfilled. They feed only the head-to-head duel record
  and nemesis lists ([04](04-head-to-head.md)); SR does not need them. They
  can be added later at the cost of a later start for those features.
- **Rejoins are merged at ingest**, not on the website and not in the
  Workshop.
- **Raw logs are stored unchanged** and uploads are idempotent by file hash.
- **A thin uploader runs on the host PC.** It only sends files; all processing
  happens server-side.
- **Deployment order:** v2-capable parser and storage go live first, then the
  new Workshop script is published.

## v2 log lines

All times are seconds from round start (match time). Names never contain
commas: BattleTags are 3–12 letters (accents allowed) and digits, with no
spaces or symbols, and cannot start with a digit. Lines start with `#`,
which no player name can.

| Line | Fields | Notes |
|---|---|---|
| `#V` | `2`, script version | First line of the round |
| `#R` | round length, winner name | One per round |
| `#P` | session, name, slot, start, end, status, kills, deaths, shots, hits, crouches, AFK seconds | One per session. Status: `0` present at end, `1` left, `2` kicked |
| `#K` | kill codes, several per line | One code per kill: killer session × 100 + victim session. Ingest counts the pairs |

Scope time and low-charge shots are not logged. Lines longer than the
Workshop string limit are split across several log calls. The script must
stay within the Workshop element limit (commonly cited as 20,000); the
editor shows the count.

## Workshop changes

All stats are measured live from game events (shots, hits, kills,
crouches), to the server tick. Nothing is sampled. The round is
written to the log once, at match end; nothing is sent during the round.

- **Sessions, not slots or names.** On `Player Joined Match`, append a new
  entry to global session arrays (name, slot, start time) and store its
  session number in a player variable. Entries are never reused, so a new
  player in a leaver's slot cannot overwrite or inherit their data, and two
  players with the same name stay separate. Arrays reset with the match.
- **Keep session stats where a leaver can't lose them.** When
  `Player Left Match` fires, the player's variables and name are no longer
  available, so stats must already be in the session arrays. Preferred:
  write to the session entry at the moment each counter changes (in the
  existing kill, death, shot, hit and crouch rules), so there is no polling
  and nothing is ever stale. Fallback: copy counters every 5–10 s in the
  existing `Per player timer` loop; a leaver then loses up to that many
  seconds of stats. Either way, the leave time is recorded in the
  `Player Left Match` rule (by finding the session whose player is no longer
  in the match), so session length stays exact.
- **Kills:** in the existing `Player Dealt Final Blow` rule, append one
  number per kill (killer session × 100 + victim session) to a global array.
  That is one action per kill, written out at match end; ingest counts the
  pairs. A round has a few hundred kills, well inside the 1,000-element
  array limit.
- **AFK time:** add the seconds spent in the existing AFK state to the
  session (used by [01](01-skill-rating.md) to excuse rounds where a player
  was not playing). Shots and hits are already counted for accuracy.
- **Server load:** all of this is event-driven or rides the existing
  `Per player timer` loop, which already runs every second for every
  player. A host-only **Show server load** Workshop setting displays Server
  Load, Average and Peak; compare them in a full lobby before and after the
  change. Existing savings worth taking in the same update: one shared
  "#1 Accuracy / Kills per min" HUD text instead of one per player, and
  recomputing the top-accuracy player once a second instead of on every
  shot.
- At match end, write `#V`, `#R`, all `#P` and `#K` lines.

## Site changes

- **Parser:** accept v1 and v2. v2 `#P` rows map onto the existing fields
  (`time_in_lobby = end − start`, accuracy from hits/shots, K/D and kills/min
  derived), so existing stats keep working.
- **ELO weight:** v2 rounds weigh each player's active time (time present
  minus AFK) as a share of the round, and kills per minute uses active time.
  Leavers, late joiners and rejoiners count partially; fully AFK sessions
  count for nothing ([ranking](../ranking.md#rating)).
- **Storage:** new tables for raw logs (text, hash, filename, host,
  uploaded at), player sessions and kill pairs.
- **Merging:** sessions with the same name and non-overlapping times in one
  round become one participation: kills, deaths, shots and time summed.
  Overlapping sessions with the same name are a name collision, handled by
  [06](06-identity.md).
- **Idempotency:** a file whose hash is already stored is reported as already
  imported and changes nothing.

## Uploader

- Single-file Python script, standard library only, in `tools/uploader/`.
- Watches the Overwatch Workshop log folder, uploads each new `Log-*.txt`
  once its size has stopped changing, and remembers uploaded hashes locally.
- Sends the existing `x-api-key` and a configured host name. The key lives in
  the host's local config, never in the repository.
- Retries with backoff when offline; never deletes logs.

## Readings

Server load for v3.5.0, measured the same way as
[07's readings](07-workshop-performance.md#readings): Necropolis, 12 players
(11 bots and the host), Ranked off, by eye from the host's load display.

| Version | Server | Average | Peak |
|---|---|---|---|
| v3.5.0 | 30 ms | 30–50 | Mostly 60–90; about 122 a couple of times |

Within the targets except for those spikes, which came less often than in
earlier tests. Session and kill tracking adds no visible load: v3.4.2 read
30–50 with peaks up to about 110 on a 115 ms server, and higher on 60 ms
servers. Load varies more between servers than between versions, so this
rules out a large regression rather than measuring a small one. Ranked mode,
which writes the log at the win, is still to be measured with real players.

## Out of scope

- Real-time streaming from the game. Workshop logs are only available as
  files after the round.
- Changing how v1 rounds are stored.

## Done when

- A v2 round with a leaver, a rejoin and kill pairs imports
  into the right tables, with the rejoin merged.
- v1 files still import exactly as before; existing tests pass.
- Uploading the same file twice changes nothing.
- The uploader has imported a full evening of rounds without manual uploads.
- The README and a `docs/workshop-log-format.md` describe v2 and name the
  script version that introduced it.

Size: **medium**. Workshop work plus a parser, three tables and a small script.

Format v4 (Workshop v3.7.0) also captures exact AFK breaks through existing
event rules, including terminal closure after leave/kick/win. Older interval
timing remains unknown. See [the contract](../workshop-log-format.md#v4).
