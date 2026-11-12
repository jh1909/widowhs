# AGENTS.md

## What this is

WIDOW HS is the leaderboard and stats site for Widow HS, an Overwatch custom
game: Widowmaker only, scoped headshots only, first to 50 kills. Live at
[widowhs.com](https://widowhs.com).

## How the parts fit

The Workshop script runs in game and, in Ranked mode, writes a match log
when a round ends. The uploader on the host PC (`tools/uploader/`) or an admin
sends it to the `upload-csv` Edge Function, which stores the file and skips
files already imported. Supabase Postgres stores the round and computes
everything derived from it. The React site only displays. See
[docs/architecture.md](docs/architecture.md).

## Rules that hold it together

1. **The database is the source of truth.** ELO, ranks, placements, PBs,
   caches and history are computed in Postgres from stored rounds, by
   triggers and server-side functions. Browsers never write them; anything a
   browser sends is recomputed.
2. **Imports are all or nothing, and checked for staleness.** An import
   prepared before another import, a reset, a rename or a moderation action
   is rejected (HTTP 409) without writing.
3. **The match log is a contract.** One file is one round. The Workshop
   script's output and `supabase/functions/upload-csv/parser.ts` change
   together, parser first. See [docs/game-mode.md](docs/game-mode.md).
4. **Players are identified by display name.** Profiles are keyed by name;
   previous names and linked Battle.net names are aliases. An ambiguous name
   rejects the import. Discord login never claims a profile; Verified means
   a linked Battle.net account.
5. **Admin powers are checked by the database** and recorded in
   `audit_logs`.
6. **Test on staging, then production.** There are two Supabase projects,
   staging and production, and a Git branch isolates neither. Migrations are
   applied by hand, in order: staging first. A push to `main` deploys the
   website against production. See
   [docs/development.md](docs/development.md#environments).

## Working on it

Run `npm test`, `npm run lint` and `npm run build` before pushing. Database
changes are new migrations, never edits to applied ones, each with a test.
Setup, environments and deployment: [docs/development.md](docs/development.md).

## Where to look

| Working on | Read |
|---|---|
| The match log, parser or Workshop script | [docs/game-mode.md](docs/game-mode.md), [docs/workshop-log-format.md](docs/workshop-log-format.md), `supabase/functions/upload-csv/` |
| Rating, leaderboard, match history, badges | [docs/ranking.md](docs/ranking.md) |
| Login, profiles, Battle.net, renames | [docs/accounts.md](docs/accounts.md) |
| Imports, moderation, reset, admin pages | [docs/admin.md](docs/admin.md) |
| Setup, tests, migrations, deployment | [docs/development.md](docs/development.md) |
| Data flow or the target database | [docs/architecture.md](docs/architecture.md), [docs/schema.md](docs/schema.md) |
| Planned work | [docs/briefs/README.md](docs/briefs/README.md): pick a brief and keep its status current |
| Why something was done a certain way | [docs/history/](docs/history/README.md) |

## Writing docs

- Describe how things work now, with the essential justification. Update
  the relevant doc in place; don't let it become your session log.
- Exact numbers and thresholds live in code and tests; link to them.
- Deployment steps go in the migration's header comment or the PR;
  verification results go in the PR.
- Move a doc to `docs/history/` when it has been actioned or no longer
  reflects the current or planned state of the project. Docs there are not
  kept up to date.
