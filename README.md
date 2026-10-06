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

## Reset test/release statistics

Administrators can open **Admin → Reset leaderboard**, type `RESET` and clear all
match data. This deletes `player_matches` and `player_history`, resets player
statistics, badges and ranks, and leaves the leaderboard empty until a new import.
Accounts, names, Discord pictures, linked Battle.net names, admin roles, bans and
audit logs remain. Each reset creates an audit entry and can be used again before
the full release. The site has no undo for this operation.

Apply `supabase/migrations/20261005210000_admin_leaderboard_reset.sql` **before**
deploying the updated `upload-csv` Edge Function and frontend. The migration adds
an authenticated, database-checked admin RPC; no extra Edge Function is needed.
Authorization requires a `players` row with `user_id = auth.uid()` and
`is_admin = true`. The legacy frontend username shortcut does not grant reset
permission. Set the admin flag for the correct Auth user UUID in the Supabase
dashboard or SQL Editor, using a trusted project administrator account.

Resets and imports run transactionally. The importer captures a revision before
reading statistics; a reset or another import invalidates that snapshot. A stale
upload returns HTTP 409 without writing anything. Only retry files that belong
to the current test/release period. Statistics, match history, shifted ranks and
the audit entry are persisted together, including rollback on errors.

The reset tests execute the actual migration in a local PostgreSQL engine
(PGlite), including permissions, preservation of accounts, rollback, repeat resets
and rejection of stale imports. They never connect to a live Supabase database.

## Achievements

Slayer requires the **current total K/D shown on the profile**, above 2.00.
The ratio is computed from total kills and deaths at the displayed two-decimal
precision, rather than the average of individual match ratios. It disappears
when the current ratio falls below the threshold and can be earned again.

Speedrunner requires a match with at least 50 kills (the winning score) and
`0 < total_match_time < 180` seconds. The profile checks for a qualifying match
separately from the displayed history, so older wins still count. Personal lobby
time is not the round duration; legacy records without total duration do not
qualify. The badge remains while that winning match exists, and the admin reset
clears it by deleting match history. No new migration or importer deployment is
required for this feature if the existing total-duration migration is installed.
