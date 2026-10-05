# WIDOW HS.

WIDOW HS is an Overwatch custom game, designed to measure your Widowmaker accuracy, kills, and mechanics against others. This project acts as the official leaderboard and statistics tracker. 

## Features
- Global leaderboard
- Detailed player statistics and matching metrics
- Secure matching and tracking
- Discord integration

## Community & Support
Join our official Discord community for events, feature updates, and to talk with other players!
- [WIDOW HS Discord](discord.gg/PKYGBFV
)

## Technology
This front-end is built using React, Vite, and Tailwind CSS. The backend connects to Supabase for an integrated database solution and Discord OAuth for authentication.

## Match imports
The leaderboard sorts by numeric ELO descending and assigns unique global
positions before search or pagination. Equal scores are ordered by player name.
The signed-in player is highlighted at their actual position. Imports recalculate
ranks against all existing players, including players absent from that upload.

The admin upload accepts one or more `.csv` and `.txt` files (up to 5MB per file)
through the file picker, with comma-separated records:

```text
[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271
```

Columns: player, kills, deaths, accuracy, kills/min, KDR, crouches, time in lobby,
total match time. Times are in seconds. Timestamps and a header row are optional.
Timestamped records can also appear on the same line. Legacy eight-column CSV
files retain their original lobby time; their total match time is unknown (`NULL`).
Imports add matches to tracked players, including linked Battle.net accounts.
Multiple files are sent in one request using repeated `file` form fields. Each
file is parsed separately, then all matches are aggregated together. A malformed
file rejects the batch before statistics are changed; the error identifies its
filename. Single-file and raw-text automation uploads remain supported.

Before deploying the updated importer, apply
`supabase/migrations/20261005120000_add_total_match_time.sql` to add the nullable
`player_matches.total_match_time` column. Then deploy the existing `upload-csv`
Edge Function and the frontend. The function URL remains compatible with existing
automation clients. For a configured Supabase CLI:

```sh
supabase db push
supabase functions deploy upload-csv
```

Run `npm test`, `npm run lint` and `npm run build` for local validation.
