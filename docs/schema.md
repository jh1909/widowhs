# Database schema after the briefs

The target `public` schema once all [briefs](briefs/README.md) are built.
Only key columns are shown. Based on the production schema of 30 October 2026
plus later migrations, none of which add tables.

Players are keyed by `name`, as today; renames cascade.

## Ingest and rounds

From [00](briefs/00-logging-and-ingest.md), [03](briefs/03-conduct.md) and
[06](briefs/06-identity.md).

```mermaid
erDiagram
  raw_logs ||--|| rounds : "parsed into"
  rounds |o--o| rounds : "continues from"
  rounds ||--o{ player_sessions : "has"
  rounds ||--o{ player_matches : "has"
  player_matches |o--|{ player_sessions : "merged from"
  player_sessions ||--o{ round_kill_pairs : "killer"
  player_sessions ||--o{ round_kill_pairs : "victim"
  player_sessions ||--o{ conduct_events : "subject of"
  players ||--o{ player_matches : "plays"

  raw_logs {
    uuid id PK
    text sha256 UK "re-upload is a no-op"
    text filename
    text host_name "from the uploader"
    int format_version "1 or 2"
    text script_version
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
    numeric lobby_sr_mean "from 01"
    numeric lobby_sr_min
    numeric lobby_sr_max
  }
  player_sessions {
    uuid id PK
    uuid round_id FK
    uuid participation_id FK "null while quarantined"
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
    numeric scoped_seconds
    int low_charge_shots
    int crouches
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
    numeric scoped_seconds "NEW"
    int low_charge_shots "NEW"
    numeric elo_weight "seed round"
    numeric performance_score "seed round"
  }
  round_kill_pairs {
    uuid round_id FK
    uuid killer_session_id FK
    uuid victim_session_id FK
    int kills
  }
  conduct_events {
    uuid id PK
    uuid round_id FK
    uuid session_id FK
    text rule "opportunistic_walkers / walkers / spammers"
    text action "afk / warn / kick / rekick"
    numeric at_s
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
  rating_params ||--o{ rating_events : "computed with"
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
    numeric sr
    numeric uncertainty "grows while inactive (02)"
    numeric cautious_sr "sr minus 2 x uncertainty"
    bool placed
    int rank
    numeric rated_weight
    timestamptz last_rated_at
  }
  rating_events {
    uuid round_id PK, FK
    text player_name PK, FK
    int params_version FK
    numeric weight "time present / round length"
    numeric sr_before
    numeric sr_after
    numeric uncertainty_before
    numeric uncertainty_after
    numeric expected_share
    numeric actual_share
    numeric performance "actual minus expected"
  }
  rating_params {
    int version PK
    numeric d
    numeric beta "winner's bonus"
    jsonb settings "K range, share curve, decay pace"
    bool active
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
| `raw_logs` | New | 00 |
| `rounds` | New, backfilled from existing `match_id` values | 00, 01, 06 |
| `player_sessions` | New, backfilled from existing rows | 00, 06 |
| `round_kill_pairs` | New, v2 rounds only | 00 |
| `conduct_events` | New, v2 rounds only | 03 |
| `player_matches` | `match_id` references `rounds`; new shot, scope, session and status columns; ELO weight kept for the seed round | 00 |
| `player_ratings` | New; takes over `rank` | 01, 02 |
| `rating_events` | New, one row per player per rated round | 01 |
| `rating_params` | New, so every rating can be replayed exactly | 01 |
| `rating_drift_daily` | New | 02 |
| `badges`, `player_badges` | New; achievements and stat medals move here from the browser | 05 |
| `player_profile_details` | Adds `pinned_badge` | 05 |
| `players` | `elo`, `rank` and the `elo_*` sums retired; other stats unchanged | 01 |
| `player_history`, `player_elo_legacy` | Frozen at SR launch as seed-round history | 01 |
