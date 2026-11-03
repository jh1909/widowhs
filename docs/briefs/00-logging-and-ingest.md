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

- **New log format (v2), marked by a version line.** Files without it are
  parsed as today (v1). Both are supported indefinitely.
- **Every player session is logged**, including leavers and kicked players,
  with kills gained during that session so rejoin sessions can be summed.
- **Kill pairs** are logged per round from the first v2 round onwards. Older
  rounds cannot be backfilled.
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
| `#P` | name, slot, start, end, status, kills, deaths, shots, hits, scoped seconds, low-charge shots, crouches | One per session. Status: `0` present at end, `1` left, `2` kicked |
| `#K` | killer, victim, count | Nonzero pairs only |
| `#C` | name, rule, action, time | Conduct events from [03](03-conduct.md). Action: `afk`, `warn`, `kick`, `rekick` |

Low-charge shots are scoped shots fired under 20% charge (under ~0.18 s
scoped; see [03](03-conduct.md)). Lines longer than the Workshop string limit
are split across several log calls. The script must stay within the
Workshop element limit (commonly cited as 20,000); the editor shows the
count.

## Workshop changes

All stats are measured live from game events (shots, hits, kills, crouches,
scope in and out), to the server tick. Nothing is sampled. The round is
written to the log once, at match end; nothing is sent during the round.

- Copy each player's live counters every second into global arrays keyed by
  name, so a leaver's stats survive `Player Left Match`. This is required:
  when that event fires, the player's variables and name are no longer
  available. A leaver loses at
  most the last second; players present at the end are logged from the live
  counters. The copy runs in the existing `Per player timer` loop.
- Track kills per victim name in the `Player Dealt Final Blow` rule.
- Track scoped time, shot count and low-charge shots (also used by 03).
- At match end, write `#V`, `#R`, all `#P`, `#K` and `#C` lines.

## Site changes

- **Parser:** accept v1 and v2. v2 `#P` rows map onto the existing fields
  (`time_in_lobby = end − start`, accuracy from hits/shots, K/D and kills/min
  derived), so existing stats keep working.
- **Storage:** new tables for raw logs (text, hash, filename, host,
  uploaded at), player sessions, kill pairs and conduct events.
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

## Out of scope

- Real-time streaming from the game. Workshop logs are only available as
  files after the round.
- Changing how v1 rounds are stored.

## Done when

- A v2 round with a leaver, a rejoin, kill pairs and a conduct event imports
  into the right tables, with the rejoin merged.
- v1 files still import exactly as before; existing tests pass.
- Uploading the same file twice changes nothing.
- The uploader has imported a full evening of rounds without manual uploads.
- The README and a `docs/workshop-log-format.md` describe v2 and name the
  script version that introduced it.

Size: **medium**. Workshop work plus a parser, three tables and a small script.
