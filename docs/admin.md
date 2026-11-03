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

Every file is stored unchanged with its SHA-256. A file uploaded again,
or twice in one batch, is reported as already imported and changes nothing.
Files imported before raw logs were stored (November 2026) have no hash, so
uploading one of those again still imports it twice.

### Uploader on the host PC

`tools/uploader/widowhs_uploader.py` (Python 3.9+, no packages) watches the
Workshop log folder and uploads each new `Log-*.txt` once it has stopped
changing. Copy the script to the host PC, put an `uploader.json` next to it
with the function URL, the API key and a name for the PC (the script's
docstring has the template), and run `python widowhs_uploader.py`. It retries
with backoff while offline, never deletes logs and remembers what it sent in
`uploader-state.json`. A file the server rejects is not retried; remove its
entry from the state file to try again.

On its first run the uploader records the logs already in the folder as seen
and does not upload them, because they may have been uploaded by hand before
hashes were kept. `--include-existing` uploads them too.

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
the audit log. Stored raw logs are kept, so a file imported before the reset
is still reported as already imported. There is no undo.

## Server status

Admin → Server Status checks database reachability from the admin's browser
and shows counts visible to that session. For Supabase's own status, see
[status.supabase.com](https://status.supabase.com/).
