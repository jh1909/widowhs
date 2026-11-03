# Data flow

How match data gets from an Overwatch lobby to the website.

## Current

```mermaid
flowchart LR
  OW["Overwatch custom game<br/>(hosted from someone's PC)"] --> WS["Workshop script<br/>tallies per-player stats"]
  WS -->|"at match end, Ranked mode only"| LOG["Log-*.txt file<br/>on the host PC"]
  LOG -->|"admin uploads in the browser<br/>(or a script with an API key)"| EF["Edge Function upload-csv<br/>parse, match names to profiles"]
  EF --> DB[("Supabase Postgres<br/>triggers: weights, ELO, ranks, history")]
  DB --> WEB["Website on GitHub Pages<br/>also computes badges and medals"]
```

- The [Workshop script](https://workshop.codes/widowhs) writes one record per
  player still in the lobby when someone reaches the kill target. Players who
  left earlier are not logged.
- Nothing in this repository watches the host PC. The `upload-csv` API-key
  path is commented as being for a Python caller, which is not in the repo.
- Processing happens in four places: Workshop, Edge Function, database
  triggers and the browser.

## Proposed

```mermaid
flowchart LR
  OW["Overwatch + Workshop<br/>emit raw facts only"] --> UP["Thin uploader on host PC<br/>watches log folder, sends files"]
  UP --> ING["Ingest (Edge Function)<br/>validate, merge rejoins, resolve names<br/>keep raw log + write clean rounds"]
  ING --> DB[("Supabase<br/>raw logs · clean rounds · ratings · badges")]
  RJ["Rating job<br/>(replays history when needed)"] <--> DB
  DB --> WEB["Website<br/>display only"]
```

- Processing lives in the ingest step, not on the host PC. There may be several
  hosts, the rating needs the full history, and renames, merges and bans must
  be able to re-run processing.
- Raw logs are stored unchanged so any processing change can be replayed.
- Badges and medals move server-side; the website only displays results.
