# 06 · Identity signals

## Goal

Stop two different people with the same display name being merged into one
profile, and make identity as reliable as the game allows, without
behavioural analysis.

## Limits

- The Workshop exposes only the display name: no BattleTag number, no account
  ID. No log can uniquely identify a player.
- The importer matches names case-insensitively. Two players with the same
  name in one round both land on one profile today.
- Battle.net linking (85 links at the last backup) proves the claimant owns a
  BattleTag with that name, but logs still cannot tell `Foo#1234` from
  `Foo#5678`.

## Decisions

- **Collision vs rejoin.** From v2 rounds ([00](00-logging-and-ingest.md)),
  same-name sessions that overlap in time are two people (a collision);
  sessions that do not overlap are one person rejoining and are merged. In v1
  files, any name appearing twice in one round is a collision.
- **Collisions are quarantined.** Colliding rows are stored but update no
  profile. In SR ([01](01-skill-rating.md)) they count as lobby members at a
  provisional rating and receive no rating change. Admin lists them and can
  assign each row to a profile.
- **Session continuity is recorded, not acted on.** The uploader's host name
  and round times link consecutive rounds from the same host within 2 minutes.
  The same name in linked rounds is shown to admins as "continued from
  previous round" when resolving collisions. It never merges anything
  automatically.
- **Promote Battle.net linking.** Unlinked profiles with 10 or more rounds
  show a prompt to link; linked profiles keep the verified mark. Linking is
  not required for anything.
- **No behavioural fingerprinting.** Crouch counts, charge patterns and
  performance are not used for identity.

## Scope

- Collision detection at ingest, the quarantine and the Admin assignment
  tool.
- Host name and continuity links stored per round.
- The link prompt on profiles.

## Done when

- A v2 round with two simultaneous players of the same name quarantines both
  rows; a round with a rejoin merges it.
- A v1 file with a duplicate name is quarantined, not merged.
- Admins can assign quarantined rows and see continuity hints.
- The link prompt appears on eligible unlinked profiles.

Size: **small**. Depends on [00](00-logging-and-ingest.md).
