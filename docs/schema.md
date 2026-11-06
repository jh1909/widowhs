# Database schema after the briefs

The target `public` schema once all [briefs](briefs/README.md) are built.
Only key columns are shown. Based on the production schema of 30 October 2026
plus later migrations, none of which add tables.

Players are keyed by `name`, as today; renames cascade.

## Ingest and rounds

From [00](briefs/00-logging-and-ingest.md) and [06](briefs/06-identity.md).

```mermaid
erDiagram
  raw_logs ||--|| rounds : "parsed into"
  rounds |o--o| rounds : "continues from"
  rounds ||--o{ player_sessions : "has"
  rounds ||--o{ player_matches : "has"
  player_matches |o--|{ player_sessions : "merged from"
  player_sessions ||--o{ round_kill_pairs : "killer"
  player_sessions ||--o{ round_kill_pairs : "victim"
  players ||--o{ player_matches : "plays"

  raw_logs {
    uuid id PK
    text sha256 UK "re-upload is a no-op"
    text filename
    text host_name "from the uploader"
    int format_version "1 or 2"
    text script_version
    uuid match_id UK "the round it became"
    numeric round_length "v2, until rounds exists"
    text winner_name "v2, until rounds exists"
    timestamptz uploaded_at
    text text "unchanged file"
  }
  rounds {
    uuid id PK "existing match_id values"
    uuid raw_log_id FK
    timestamptz played_at
    int round_length
    text winner_name
    text host_name
    uuid previous_round_id FK "same host, under 2 min gap"
  }
  player_sessions {
    uuid id PK
    uuid round_id FK
    uuid participation_id FK "null while quarantined"
    int session_no "v2: unique per round, never reused"
    text logged_name
    int slot "v2 only"
    numeric start_s
    numeric end_s
    text status "present / left / kicked"
    text identity "resolved / collision / assigned"
    int kills
    int deaths
    int shots
    int hits
    int crouches
    numeric afk_seconds
  }
  player_matches {
    bigint id PK
    uuid match_id FK "now references rounds"
    text player_name FK
    int score
    int sessions "NEW"
    text status "NEW: present / left / kicked"
    int shots "NEW"
    int hits "NEW"
    numeric afk_seconds "NEW"
    numeric elo_weight "seed round"
    numeric performance_score "seed round"
  }
  round_kill_pairs {
    uuid round_id FK
    int killer_session_no FK "with round_id"
    int victim_session_no FK "with round_id"
    int kills
  }
  players {
    text name PK
  }
```

v1 logs also get one session per row (start = round length − time in lobby,
status present), so overlap, collisions and head-to-head use one table for
both formats.

## Players, ratings and badges

From [01](briefs/01-skill-rating.md), [02](briefs/02-rating-decay.md) and
[05](briefs/05-badges.md). Head-to-head ([04](briefs/04-head-to-head.md))
adds no tables; it reads `rating_events`, `player_matches`, `player_sessions`
and `round_kill_pairs`.

```mermaid
erDiagram
  auth_users ||--o{ players : "owns"
  auth_users ||--o| player_profile_details : "has"
  auth_users ||--o{ battlenet_account_links : "links"
  players ||--o| player_ratings : "current SR"
  players ||--o{ rating_events : "per round"
  rounds ||--o{ rating_events : "rated in"
  rounds ||--o| round_ratings : "lobby strength"
  rating_params ||--o{ rating_events : "computed with"
  rating_params ||--o{ round_ratings : "computed with"
  players ||--o{ player_badges : "holds"
  badges ||--o{ player_badges : "awarded as"
  badges |o--o{ player_profile_details : "pinned"
  players ||--o{ player_history : "seed round"
  players ||--o| player_elo_legacy : "seed round"

  players {
    text name PK
    uuid user_id FK
    bool is_banned
    bool is_verified
    text_array previous_names
    text_array bnet_accounts
    int matches "lifetime stats unchanged"
    text elo "RETIRED: replaced by SR"
    int rank "MOVED to player_ratings"
    numeric elo_weight_sum "RETIRED with the other elo_* sums"
  }
  player_ratings {
    text player_name PK, FK
    float sr
    float uncertainty "grows while inactive (02)"
    float cautious_sr "sr minus 2 x uncertainty"
    bool placed
    int rank "placed, not banned"
    float rated_weight
    int full_rounds
    timestamptz last_rated_at
  }
  rating_events {
    uuid match_id PK "the round; FK to rounds later"
    text player_name PK, FK
    timestamptz played_at "the round's time"
    int params_version FK
    float weight "active time / round length"
    bool full_round
    float sr_before
    float sr_after
    float uncertainty_before
    float uncertainty_after
    float expected_share
    float actual_share
    float performance "actual minus expected"
    float rated_weight "running total, to resume a replay"
    int full_rounds "running total"
  }
  round_ratings {
    uuid match_id PK "FK to rounds later"
    timestamptz played_at
    int params_version FK
    int lobby_players "eligible players"
    float lobby_sr_mean "time-weighted"
    float lobby_sr_min
    float lobby_sr_max
    int rated_players
  }
  rating_params {
    int version PK
    float d
    float beta "winner's bonus"
    jsonb settings "the engine's SrSettings"
    bool active "at most one"
  }
  badges {
    text id PK
    text name
    text description
    text kind "current / lifetime"
    int tiers
  }
  player_badges {
    text player_name PK, FK
    text badge_id PK, FK
    int tier
    int count
    timestamptz first_earned_at
    bool held
  }
  player_profile_details {
    uuid user_id PK, FK
    text bio
    jsonb setup
    text pinned_badge FK "NEW"
  }
  player_history {
    text player_name FK
    int elo "frozen at SR launch"
    date history_day
  }
  player_elo_legacy {
    text player_name PK, FK
    numeric weight "frozen at SR launch"
  }
  battlenet_account_links {
    text account_id PK
    uuid user_id FK
    text battletag
    text log_name
  }
  rounds {
    uuid id PK
  }
  auth_users {
    uuid id PK
  }
```

`rating_drift_daily` (day, active players, mean SR, re-anchor shift) stands
alone and is not drawn. `audit_logs`, `leaderboard_state` and
`battlenet_oauth_requests` are unchanged and not shown.

## Changes by table

| Table | Change | Brief |
|---|---|---|
| `raw_logs` | Built; holds the v2 round length and winner until `rounds` exists | 00 |
| `rounds` | New, backfilled from existing `match_id` values and raw logs | 01, 06 |
| `player_sessions` | Built for v2 rounds; v1 rows backfilled later | 00, 06 |
| `round_kill_pairs` | Built, v2 rounds only | 00 |
| `player_matches` | Built: session, status, shot, hit and AFK columns. Later: `match_id` references `rounds`; ELO weight kept for the seed round | 00, 01 |
| `player_ratings` | New; takes over `rank` | 01, 02 |
| `rating_events` | New, one row per player per rated round | 01 |
| `rating_params` | New, so every rating can be replayed exactly | 01 |
| `round_ratings` | New: lobby strength per rated round, until `rounds` exists | 01 |
| `rating_drift_daily` | New | 02 |
| `badges`, `player_badges` | New; achievements and stat medals move here from the browser | 05 |
| `player_profile_details` | Adds `pinned_badge` | 05 |
| `players` | `elo`, `rank` and the `elo_*` sums retired; other stats unchanged | 01 |
| `player_history`, `player_elo_legacy` | Frozen at SR launch as seed-round history | 01 |
