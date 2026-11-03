# Accounts and profiles

## Profiles

Every name that appears in a log gets a profile, unclaimed until someone
links it. Logs carry display names only, so names are how rounds reach
profiles: a log name matches a profile's current name, one of its previous
names, or a linked Battle.net name, case-insensitively. If a name could
belong to more than one profile, the import is rejected rather than guessed.
Two different players with the same name in one round still land on one
profile ([brief 06](briefs/06-identity.md) addresses this).

## Login and verification

Players log in with Discord. Logging in finds or creates the player's own
profile; a Discord name that matches an imported profile never claims it.

Linking Battle.net (the `battlenet-oauth` Edge Function) is how a player
proves a name is theirs:

- Up to two Battle.net accounts per player. A linked account earns the
  **Verified** badge; removing the last one removes it.
- Linking a name merges that name's unclaimed profile, with its rounds and
  stats, into the player's own.
- A verified claim beats an unverified one; between verified claims, the
  first wins.
- Battle.net account IDs are private and never appear in public data.

## Renames

A profile's owner or an admin can rename it. History moves with it, the old
name is kept as an alias so new logs under it still match, and names already
in use are rejected. A rename invalidates any import prepared before it.

## Bio and setup

Optional profile text: a bio and gear and settings fields. The owner and
admins can edit them; admin edits to other profiles are audited. They are
shown as plain text, stored privately per login, and deleted with the
player's last profile.
