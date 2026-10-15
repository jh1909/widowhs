# WIDOW HS.

WIDOW HS is an Overwatch custom game, designed to measure your Widowmaker accuracy, kills, and mechanics against others. This project acts as the official leaderboard and statistics tracker. 

## Features
- Global leaderboard
- Global match history with all-player result dialogs
- All log participants are tracked, with verified Discord-linked profiles
- Detailed player statistics and matching metrics
- Secure matching and tracking
- Discord integration

## Community & Support
Join our official Discord community for events, feature updates, and to talk with other players!
- [WIDOW HS Discord](https://discord.gg/pTHzBNSyEy)

## Technology
This front-end is built using React, Vite, and Tailwind CSS. The backend connects to Supabase for an integrated database solution and Discord OAuth for authentication.

## Match imports
The leaderboard sorts by numeric ELO descending and assigns unique global
positions before search or pagination. Equal scores are ordered by player name.
The signed-in player is highlighted at their actual position. Imports recalculate
ranks against all existing players, including players absent from that upload.

The homepage **Matches played** counter counts rounds, with one uploaded file
representing one round. All player records from that file share a
`player_matches.match_id`, and `get_match_count()` counts distinct round IDs
in the database without a client-side row limit. Personal match totals still
count each player's participation. Admin resets also clear the round count.

Apply `supabase/migrations/20261012130000_count_imported_rounds.sql` after the
match-date migration and before deploying the updated `upload-csv` function
and frontend. Existing records are grouped by `played_at`; when no original
match time was recorded, this is the upload timestamp. Older multi-file uploads
cannot be separated reliably after the fact. During the deployment transition,
an older importer without round IDs is counted as one round per request.

The admin upload accepts one or more `.csv` and `.txt` files (up to 5MB per file)
through the file picker, with comma-separated records:

```text
[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271
```

Columns: player, kills, deaths, accuracy, kills/min, KDR, crouches, time in lobby,
total match time. Times are in seconds. Timestamps and a header row are optional.
Timestamped records can also appear on the same line. Legacy eight-column CSV
files retain their original lobby time; their total match time is unknown (`NULL`).
Imports store all participants, creating unclaimed profiles for new names.
Linked Battle.net accounts and previous profile nicknames map to their existing
profiles. Ambiguous account links reject the import instead of
assigning a match to the wrong player.
Multiple files are sent in one request using repeated `file` form fields. Each
file is parsed separately, then all matches are aggregated together. A malformed
file rejects the batch before statistics are changed; the error identifies its
filename. Single-file and raw-text automation uploads remain supported.

Filenames such as `Log-2026-10-11-20-12-49.txt` supply the match date and time.
The filename is interpreted in `Europe/Berlin`, including summer/winter time,
and saved as `player_matches.played_at`. Match history displays and sorts by
this timestamp; `created_at` remains the upload timestamp. Existing matches,
other filenames and raw-text uploads use the original upload timestamp because
their match date cannot be recovered from stored data. Invalid calendar dates
in recognized log filenames reject the batch.

For filename dates, apply
`supabase/migrations/20261012120000_add_match_date.sql` **before** deploying
the updated `upload-csv` function and frontend. This migration requires the
earlier duration and admin-reset migrations. The date tests run the migration
and importer in local PostgreSQL (PGlite), verifying timestamps, legacy rows,
transaction rollback and service-only permissions.

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

## Global match history and verification

Apply `supabase/migrations/20261012140000_global_match_history.sql` **after** the
existing rename, match-date and round-ID migrations. Then deploy the updated
`upload-csv` function and frontend. The Supabase Dashboard can be used for both:
run the migration in the SQL Editor, then replace the Edge Function's code with
the generated standalone `outputs/upload-csv-dashboard.ts` from the workspace.

The `/matches` page lists rounds newest first with server-side pagination.
Opening a round loads all saved participants and their stats, ordered by kills.
The public RPCs expose game results and display avatars; they exclude auth IDs,
account aliases, emails and admin permissions. Imports retain each original log
name separately from the current profile name. Renames therefore preserve the
match identity and original participant name. Admin resets clear this history.

`players.is_verified` is maintained by a database trigger. On the Battle.net OAuth
branch it requires a trusted Discord identity and a server-verified Battle.net
account linked through Blizzard. Existing typed names alone do not award the badge.
Removing the last linked account removes the badge. Login uses
`ensure_discord_player`; matching Discord display names alone never claim an
imported profile. The OAuth completion checks ownership, account collisions and
the two-account limit; `link_bnet_account` now allows only unlinking. Linking a previously unclaimed player moves its saved
matches/history into the owner's profile, combines aggregate stats, recalculates
ELO/ranks and invalidates concurrent imports atomically. Both existing `text[]`
and `jsonb` account columns are supported. Imports preserve ownership and roles.

## Battle.net OAuth test branch

See [the setup and testing guide](docs/battlenet-oauth-testing.md) for the Blizzard
client, exact callback/return URLs, Supabase migration, dashboard deployment and
manual tests. Discord remains the site login. The additional `battlenet-oauth`
Edge Function links Blizzard's stable account ID and full BattleTag to that user.
The first claimant keeps a log name; conflicting names/accounts are rejected.
New claims require OAuth, up to two accounts, and legacy names retain their stats.
Private account IDs never appear in public player rows or match-history RPCs.

Use a separate test database: a frontend Git branch does not isolate Supabase.
The new migration changes account linking and badge rules for every frontend
connected to the same database. Browser/JWT binding and single-use state prevent
cross-user link attempts; callback GET prepares proof and authenticated POST
completes the claim only from the initiating browser. No provider tokens persist.

Old imports only contain the participants saved at the time; discarded players
cannot be recovered from the database. New imports keep every named participant.
The importer reads all profile pages, accepts a configured automation API key or
a server-validated admin session, and rejects non-admin browser imports.

## Rating

Player profiles display gold, silver and bronze medals on their K/D, accuracy,
crouches/minute and pace (KPM) stats cards, based on the full placed population.
Equal displayed values share a medal. See [stat medals](docs/stat-medals.md).
This requires only the frontend push, with no database or Edge Function update.

Match performance scores and profile ELO use the same formula, rounded once to
the nearest integer:

```text
Pace = min(KPM / 16.67, 1.67)
Acc  = min(Accuracy / 60, 1.15)
KDR  = min(KDR, 4.0) / 3.0
Rating = (650 * Pace + 250 * Acc + 100 * KDR)
```

Accuracy is a percentage (e.g. 60), not a fraction. Profile ELO applies the
formula to the participation-weighted averages of KPM, accuracy and KDR; match scores apply it
to that match's statistics. A rating of at least 1200 still grants the PRO tag.

See [weighted ELO and placement rules](docs/weighted-elo.md). Install
`20261013233000_weighted_elo_participation.sql` before publishing the frontend.
It recalculates current profile ELO from stored matches and requires 10
fully eligible matches for leaderboard qualification. Install the subsequent
`20261014010000_count_fully_eligible_placements.sql` correction too: reduced
weights affect ELO but do not count towards placements. Raw round ratings, general
stats and PBs remain unchanged. Match views label excluded/reduced participation.
Existing Edge deployments remain compatible; no function redeployment is required.

Deploy the updated `upload-csv` function, then apply
`supabase/migrations/20261007120000_update_rating_formula.sql` while uploads are
idle. The migration recalculates existing match scores, current player ELO and
all ranks, preserving accounts and match statistics. Old ELO history remains as
recorded; a new history snapshot is added where ELO or rank changes. Existing
profile averages are stored at two-decimal precision, which is also the input
for this one-time recalculation. The migration requires the earlier admin-reset
migration and invalidates any imports computed before it.

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

## Admin player moderation

For admin ban/unban and profile deletion, apply
`20261015120000_admin_player_moderation.sql` and deploy the frontend. Actions are
verified server-side and audited transactionally; banned players cannot appear
in rankings, records or profile medals. See [player moderation](docs/player-moderation.md).

## Admin database status

Server Status reports measured database connectivity, request duration, HTTP
status, the last successful check and verified counts accessible to the session.
Timeouts, offline state and permission errors are distinguished; unavailable
counts are not shown as zero. Hardcoded region/uptime claims were removed.
See [server status](docs/server-status.md). This requires only a frontend push.

## Achievements

No Croucher requires at least one played match, known crouch statistics and a
positive total personal playing time. The current overall rate must be at most
**0.1 crouches per minute**, allowing one misclick per ten minutes of play.
It disappears when the rate exceeds this threshold and returns when the rate
falls back to it. The profile uses a standing-person icon. No database update
or Edge Function deployment is needed.

Leaderboard, profile and Slayer use the same stored `players.kdr` value: the
current average K/D of the matches. The profile labels it **Avg K/D**. Slayer
requires this value to be above 2.00 at the displayed two-decimal precision. It
disappears when the current value falls below the threshold and can be earned
again. Unknown K/D is shown as a dash and never grants Slayer.

Squat Master requires a current average of at least **100 crouches per match**:
`players.crouches / players.matches >= 100`. Missing or zero match counts never
grant the badge, and it disappears when the average drops below the threshold.
The crouch stats card displays this average alongside the time-weighted
crouches/minute rate. These are frontend changes using existing aggregate data.

Profiles currently ranked 1–3 receive blue/gold, red/gold or green/gold frames
around the player card. Small, equally sized winged crests and the rank are
integrated into the card. The decoration reflects the current rank and disappears
when a player leaves the podium or stats are reset.
The frame becomes more ornate with each higher place: first place has a double
gold border, layered corner scrollwork and central gem ornaments; second place
has simpler scrollwork and smaller central ornaments; third place has restrained
geometric corners. Crests and card layouts remain equally sized across ranks.

The profile shows ELO and a PB for 50-kill wins. PB is the shortest positive
`time_in_lobby` among matches with at least 50 kills, formatted as a duration:
the player's time from joining the lobby until reaching the winning score.
Players without a recorded winning duration see a dash.

Speedrunner requires a match with at least 50 kills (the winning score) and
`0 < total_match_time < 180` seconds. The profile checks for a qualifying match
separately from the displayed history, so older wins still count. Personal lobby
time is not the round duration; legacy records without total duration do not
qualify. The badge remains while that winning match exists, and the admin reset
clears it by deleting match history. No new migration or importer deployment is
required for this feature if the existing total-duration migration is installed.

## Nickname changes

Apply `20261012100000_fix_admin_reset_where.sql` and
`20261012110000_preserve_player_history_on_rename.sql` from `supabase/migrations`,
then deploy `upload-csv` and the frontend. The earlier admin-reset migration is
required. The first migration makes the reset compatible with pg-safeupdate.

Renaming uses the authenticated `rename_player` RPC. Only the profile owner by
`user_id` or a database-flagged admin may rename a profile. Match and ELO history
change names in the same transaction; the Auth user UUID and all statistics stay
unchanged. The trigger also handles older frontends that update the name directly.
The frontend updates its auth context and navigates through the hash router;
renaming another player as an admin does not change the admin's Auth metadata.

Previous nicknames are retained in `players.previous_names` as import aliases,
separate from Battle.net accounts. Name collisions are rejected. Imports computed
before a rename return HTTP 409 rather than writing to an outdated name.

The migration protects future nickname changes. Installing it preserves existing
profiles and histories without guessing any past nickname associations.
