# WIDOW HS

The leaderboard and stats site for **Widow HS**, an Overwatch custom game:
Widowmaker only, scoped headshots only, first to 50 kills. Every ranked round is
recorded, so anyone who plays gets a profile, a rating and a place on the
board.

Live at **[widowhs.com](https://widowhs.com)**.

## Play

- Load share code **`TCG2W`** in Overwatch's custom games, or find
  [Widow HS 2.0 on Workshop.codes](https://workshop.codes/widowhs).
- Lobbies with the **Ranked mode** setting on count towards the leaderboard.
- Join the [WIDOW HS Discord](https://discord.gg/pTHzBNSyEy) for events,
  updates and lobbies.

## What the site does

- A global leaderboard, and a profile for every player with rating, stats,
  personal bests, history and badges
- Every recorded round in the match history, with each player's result
- Discord login, and Battle.net linking to verify that a name is yours

## How it works

The game mode writes a log at the end of each ranked round: every player
session, including players who left, and every kill. Since script v3.5.0 this
is the v2 [log format](docs/workshop-log-format.md). An uploader on the host
PC (or an admin) sends it to the site, the database works out every rating and
rank, and the website shows the results. [Architecture](docs/architecture.md)
has the diagram.

## Get started

You need Node 20 and npm.

```sh
npm install
cp .env.example .env.local   # then set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3000
npm test
```

Use the staging Supabase project for local work, not the live one; see
[development](docs/development.md#environments).

## Contributing

- [AGENTS.md](AGENTS.md): how the project fits together and the rules that
  keep it working. Start here.
- [docs](docs/README.md): how each part of the site works.
- [Briefs](docs/briefs/README.md): planned work and what's next.
