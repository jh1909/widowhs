# Workshop log format

The match log is the contract between the Workshop script and the site
([AGENTS.md](../AGENTS.md#rules-that-hold-it-together), rule 3). One file is
one round. The parser is `supabase/functions/upload-csv/parser.ts`; ingest
(merging rejoins, hashing) is `supabase/functions/_shared/log-ingest.ts`.

Overwatch writes each `Log To Inspector` call as one line, prefixed with the
time of day (`[20:15:09] `), to `Log-YYYY-MM-DD-HH-MM-SS.txt` in the Workshop
log folder. The site reads the round's date from the file name as Berlin time
and strips the prefixes.

**v3** (Workshop v3.6.0) adds timestamped score changes for rolling-lobby SR.
**v2** was introduced by Workshop v3.5.0. Files whose first line is `#V`
declare their format version; other files are read as v1. All are supported.

## v3

Uses the same `#R`, `#P` and `#K` records as v2, with `#V,3,3.6.0` and extra
`#S` lines. Each `#S` line contains session/time/score triples, in event order:

```text
#S,1,20,1,2,25,1,1,30,2
#S,1,40,1,0,0,0,0,0,0
```

These record session 1 scoring at 20 s, session 2 at 25 s, session 1 again at
30 s, and session 1 losing a point to the environment at 40 s. The score is
cumulative within the session, starting from zero. Gains and losses change
it by one. Zero triples pad the last line. Session IDs here have no two-digit
limit; the existing `#K` encoding still has its v2 limit.

Every session has a complete history, including `[]` for a scoreless session.
The parser validates event order, session bounds, unit score changes and the
final score. Inconsistent or incomplete histories reject the whole file.
Histories are stored as `player_sessions.score_events`; older sessions keep
NULL, explicitly indicating unknown timing. Removing a banned victim does
not remove a surviving killer's history.

The Workshop captures score changes in its existing kill and environmental
death rules. It batches them at round end, three triples per line; Inspector
recording stays off during play. No new per-frame player rule is added.

## v2

Written once, in Ranked mode, at match end. Every player session is logged,
including players who left or were kicked.

```text
[20:15:09] #V,2,3.5.0
[20:15:09] #R,301.53,Alice
[20:15:09] #P,1,Alice,0,0,301.53,0,50,20,120,60,5,0
[20:15:09] #P,2,Bob,1,0,100.2,1,10,15,80,20,2,12.5
[20:15:09] #P,3,Bob,1,150.08,301.53,0,8,10,40,12,3,0
[20:15:09] #K,102,102,201,301,103,0,0,0,0,0
```

| Line | Fields | Notes |
|---|---|---|
| `#V` | `2`, script version | The first line |
| `#R` | round length, winner name | Exactly one |
| `#P` | session, name, slot, start, end, status, kills, deaths, shots, hits, crouches, AFK seconds | One per session |
| `#K` | ten kill codes | Each code is killer session × 100 + victim session; `0` pads the last line |

- **Times** are seconds of match time, from round start, with decimals.
  Session start and end come from the join and the leave (or the win for
  players still present).
- **Sessions** are numbered from 1 in join order and never reused within a
  round, so a new player in a leaver's slot gets a new session and two
  players with the same name stay apart. A rejoin is a new session.
- **Status:** `0` present at the end, `1` left, `2` kicked by the AFK rule.
- **Kills** are the player's score during the session (environment deaths
  can take one away, as in v1). **Shots** and **hits** give accuracy.
  **AFK seconds** is time spent in the AFK state.
- **Kill codes** only cover sessions 1–99. A self-kill code is ignored.
- Scope time and low-charge shots are not logged.
- Names never contain commas or start with `#`: BattleTags are 3–12 letters
  and digits and cannot start with a digit.

A malformed line rejects the whole file and names the record: unknown line
types, wrong column counts, negative or non-whole counts, a session that ends
before it starts, a repeated session number, or a kill code naming a session
with no `#P` line.

### At ingest

- Sessions with the same name (ignoring case) that do not overlap are one
  player who left and rejoined. They become one participation in
  `player_matches`: kills, deaths, shots, hits, crouches, AFK seconds and
  time are summed. Overlapping sessions with the same name stay separate
  participations until [06](briefs/06-identity.md) resolves them.
- Each participation's existing fields are derived the way the Workshop
  derived them for v1: time in lobby is the summed session time rounded
  down, accuracy is hits ÷ shots, K/D is kills ÷ max(deaths, 1). Kills per
  minute uses the summed time minus AFK time. Total match time is the round
  length rounded down. The ELO weight counts active time
  ([ranking](ranking.md#rating)).
- Sessions are stored in `player_sessions` and kill codes are counted into
  `round_kill_pairs` per killer and victim session. Banned players'
  sessions and their kill pairs are not stored.

## v1

Script versions before v3.5.0. One line per player still in the lobby when
someone reaches the kill target; players who left earlier are missing.

```text
[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271
```

Columns: player, kills, deaths, accuracy (%), kills per minute, K/D,
crouches, time in lobby, total match time. Times are whole seconds. Older
files have eight columns and no match time. A header line starting with
`Player` is skipped.

## Every file

- The file is stored unchanged in `raw_logs` with its SHA-256, file name,
  uploading host and format version. A file whose hash is already stored is
  reported as already imported and changes nothing, including after a
  leaderboard reset.
- Change the script's output and the parser together, and deploy the parser
  first.
