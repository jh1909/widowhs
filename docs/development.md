# Development

## Setup

Follow the README's [Get started](../README.md#get-started), with
`.env.local` pointing at **staging** (see Environments below).
A Git branch does not isolate the database: whichever project the site points
at is the one it reads and writes.

## Environments

| Project | URL | Use |
|---|---|---|
| Staging | `https://icjnuxlfprxwjxhexgkv.supabase.co` (named "widowhs-backup" in Supabase) | Local development and trying migrations and Edge Functions |
| Production | `https://kzymescftenxuspjsssh.supabase.co` | The live site (`supabase/config.toml`) |

Apply a migration or deploy a function on staging first, check it there, then
repeat on production. Each project has its own keys and secrets.

Staging holds a copy of production's `public` schema and data, not its auth
users. To refresh it, dump production's `public` schema and data, load them
into an empty staging `public` schema (data with
`session_replication_role = replica`, so triggers don't fire), then add
placeholder `auth.users` rows (id only) for the `user_id` values that the
copied tables reference. Then apply only the migrations production doesn't
have yet. Deploy functions to staging with
`supabase functions deploy <name> --remote=icjnuxlfprxwjxhexgkv --use-api`.

## Checks

```sh
npm test         # all tests, about 35 s
npm run lint     # TypeScript type check
npm run build
```

Run all three before pushing. Tests use Node's test runner (`tests/*.test.ts`).
Database tests build a stand-in for Supabase's roles and auth schema, apply
the real migrations to an in-memory Postgres ([PGlite](https://pglite.dev)) and
call the real functions; they never connect to Supabase.
`tests/recent-performance.test.ts` is a good model for a new one.

## Database changes

- Add a new timestamped file in `supabase/migrations`. Never edit one that has
  been applied, and never re-run an older migration after a newer one: later
  migrations replace function definitions.
- Start the file with a comment saying what it does and what must be deployed
  before and after it.
- Functions that change leaderboard data take the shared lock
  (`pg_advisory_xact_lock(1909, 1)`) and bump the leaderboard revision, so
  imports prepared earlier are rejected. Follow the existing functions.
- Raise conflicts the caller has to resolve (a stale revision, a profile that
  no longer exists) with SQLSTATE `PT409`, which PostgREST returns as HTTP
  409. Never use `40001`: PostgREST retries it by itself, so a stale request
  loops until the gateway times out.
- Migrations are applied by hand in the Supabase SQL editor (or
  `supabase db push`), on staging and then production, before deploying code
  that needs them.

## Deployment

For Workshop v3.7.0 / format v4, apply `20261105130000_afk_intervals.sql`
after the timed-score and active-time PB migrations, then apply
`20261105133000_require_v4_afk_intervals.sql`, deploy `upload-csv`,
then publish the Workshop script. Old importer calls/logs remain valid.
Validate repeated AFK returns, leave/kick while AFK, AFK at the winning event,
return/win races and full-lobby server load in Overwatch before publication;
local checks cannot establish Workshop syntax or event scheduling.


For Workshop v3.6.0 / format v3, apply
`20261104210000_timed_score_events.sql`, then deploy `upload-csv`, before
publishing the Workshop script. The importer signature is unchanged and old
logs remain supported. The separate rolling-SR migration belongs to PR #3.
The added Workshop recording uses existing event rules and writes only at
round end; validate syntax and server load in game before publishing v3.6.0.

Apply `20261105120000_active_time_personal_bests.sql` on staging and then
production before deploying the website changes. It recalculates PBs from
actual winning sessions minus AFK time; legacy logs retain their recorded
times, and public match results expose the actual winning session. The
Workshop's active-time HUD uses the existing AFK measurements and
does not change the log format. In-game checks must include AFK pause/return,
an AFK player at the win, final KPM rankings, leaving/rejoining and server load.

- **Website:** every push to `main` builds and deploys to GitHub Pages
  (`.github/workflows/deploy.yml`). Put `[skip ci]` in docs-only commit
  messages.
- **Edge Functions** (`supabase/functions/upload-csv`, `battlenet-oauth`):
  deploy with `supabase functions deploy <name>`, or paste into the dashboard
  editor (`node scripts/build-battlenet-dashboard.mjs` builds a standalone
  `battlenet-oauth`). Both have JWT verification off in `supabase/config.toml`
  and check callers themselves.
- **Workshop script** (`workshop/widowhs.ows`): published on Workshop.codes by
  its author, after the parser it needs is live
  ([game mode](game-mode.md#the-mode)).
- **Uploader** (`tools/uploader/`): copied to the host PC by hand
  ([admin](admin.md#uploader-on-the-host-pc)).
- **Secrets** live in Supabase, never in Git: `ADMIN_API_KEY`, the service
  role key, and `BATTLENET_CLIENT_ID`, `BATTLENET_CLIENT_SECRET`,
  `BATTLENET_CALLBACK_URL` and `BATTLENET_REDIRECT_URLS`. The Blizzard client's
  redirect URI is the `battlenet-oauth` function's `/callback` URL, and return
  addresses must match exactly, trailing slash included.
- **Workshop script:** published on Workshop.codes by its author; see
  [game mode](game-mode.md).

## Troubleshooting

- Firefox may report a rejected Supabase auth-lock callback; this is handled
  in `src/lib/auth-lock.ts` and is harmless.
- A `__chromium_devtools_metrics_reporter` error comes from Chrome DevTools,
  not the site. Close DevTools and reload.

## Prototypes

`scripts/sr-prototype.py` replays a production backup through the proposed
skill rating; see [brief 01](briefs/01-skill-rating.md).
