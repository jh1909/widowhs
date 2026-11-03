# Development

## Setup

Follow the README's [Get started](../README.md#get-started), with
`.env.local` pointing at **staging** (see Environments below).
A Git branch does not isolate the database: whichever project the site points
at is the one it reads and writes.

## Environments

| Project | URL | Use |
|---|---|---|
| Staging | `https://icjnuxlfprxwjxhexgkv.supabase.co` | Local development and trying migrations and Edge Functions |
| Production | `https://kzymescftenxuspjsssh.supabase.co` | The live site (`supabase/config.toml`) |

Apply a migration or deploy a function on staging first, check it there, then
repeat on production. Each project has its own keys and secrets.

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
- Migrations are applied by hand in the Supabase SQL editor (or
  `supabase db push`), on staging and then production, before deploying code
  that needs them.

## Deployment

- **Website:** every push to `main` builds and deploys to GitHub Pages
  (`.github/workflows/deploy.yml`). Put `[skip ci]` in docs-only commit
  messages.
- **Edge Functions** (`supabase/functions/upload-csv`, `battlenet-oauth`):
  deploy with `supabase functions deploy <name>`, or paste into the dashboard
  editor (`node scripts/build-battlenet-dashboard.mjs` builds a standalone
  `battlenet-oauth`). Both have JWT verification off in `supabase/config.toml`
  and check callers themselves.
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
