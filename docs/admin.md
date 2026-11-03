# Admin

An admin is a player whose profile has `is_admin` set for their login, set by
a project administrator in Supabase. Every admin action is checked by the
database, never trusted from the browser, and recorded in `audit_logs`.

## Importing rounds

Admin → upload accepts one or more `.csv` or `.txt` log files, up to 5 MB
each ([log format](game-mode.md#the-match-log)). Each file is one round. A
batch is all or nothing: one malformed file rejects it, naming the file.

Automation can post to the `upload-csv` Edge Function with the `x-api-key`
header set to the `ADMIN_API_KEY` secret.

An upload answered with HTTP 409 was prepared before another import, a reset,
a rename or a moderation action; nothing was written, so upload it again.
Uploading the same file twice imports it twice
([brief 00](briefs/00-logging-and-ingest.md) fixes this).

## Moderation

- **Ban** hides a player from rankings, records and medals, and future
  uploads skip their rows. Their data is kept; unbanning resumes tracking
  but does not restore skipped rounds.
- **Delete** removes the profile, its rounds and its history. Other players
  in those rounds keep theirs. It is not a ban: the name gets a new profile
  if it appears in a later log.
- Admins can clear another player's bio and setup.

## Reset

Admin → Reset leaderboard (type `RESET`) deletes all rounds and history and
resets every player's stats, keeping accounts, names, links, roles, bans and
the audit log. There is no undo.

## Server status

Admin → Server Status checks database reachability from the admin's browser
and shows counts visible to that session. For Supabase's own status, see
[status.supabase.com](https://status.supabase.com/).
