# Admin player moderation

Apply `supabase/migrations/20261015120000_admin_player_moderation.sql` after the
weighted ELO and fully eligible placement migrations, then deploy the frontend.
No Edge Function deployment is needed. Installing the migration does not ban or
delete anyone; it recalculates stored ranks excluding existing bans.

The old admin buttons used direct table updates/deletes and interpreted a
response without an error as success. RLS can silently filter out the target,
leaving zero changed rows. Bans were also missing from ranking/record filters.

The new `admin_moderate_player` RPC checks the caller's real `auth.uid()` and
`players.is_admin`, locks consistently with imports/account changes, requires
an existing exact player name, and returns an explicit acknowledgement. Client
metadata or a known nickname grants no permissions. Browser writes cannot change
their own ban status. Every action and its audit entry commit together; failures
roll back. The leaderboard revision invalidates imports prepared before moderation.

- Ban/unban preserves accounts, statistics and matches. Banned players are
  excluded from public rankings, record holder, podium frames and stat medals.
  Future uploads skip the banned profile and all currently linked account and
  previous nickname aliases: no new raw participation, ordinary statistics, PB,
  placement progress or ELO history. The database enforces this even with the
  previously deployed Edge Function. Existing data remains stored. Unbanning
  resumes future tracking without automatically restoring skipped matches.
  Profiles show a Banned label and no
  global rank. The admin list keeps banned profiles visible for unbanning.
- Delete removes the profile, its raw match participations, daily ELO history and
  legacy statistics. Other participants in those games are preserved. The user's
  Battle.net claims, pending OAuth requests and bio/setup are cleared only when
  no other profile belongs to that user. The Supabase/Discord login account is
  retained. This is deletion, not a permanent account ban: later sign-in or an
  imported log can create a new profile. The existing confirmation now describes
  these effects before deletion.

After a confirmed action, the admin list and counts reload from the database.
Deleting the last row on a page returns to the preceding valid page. Stale search
responses are ignored. Duplicate moderation clicks are disabled while pending.
Errors are visible and do not cause invented count changes. A missing migration
produces an actionable message rather than silently falling back to table writes.

Regression tests use PostgreSQL/PGlite with restrictive RLS and the existing
rename, verification, daily history, weighted ELO and import triggers. They cover
the original silent-zero-row failure, role enforcement, self-unban prevention,
imports after banning (including legacy payloads, Unicode names and alias
recreation attempts), audit rollback, private-data cleanup and unbanning.
