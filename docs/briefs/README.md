# Briefs

Planned work for WIDOW HS. Each brief records the goal, the decisions made,
the scope and how we know it is done. Update the status here as work moves.

| # | Brief | Size | Depends on | Status |
|---|---|---|---|---|
| 00 | [Logging and ingest pipeline](00-logging-and-ingest.md) | Medium | — | Drafted |
| 01 | [Skill rating (SR)](01-skill-rating.md) | Large | 00 improves it, not required | Drafted |
| 02 | [Rating decay](02-rating-decay.md) | Small | 01 | Drafted |
| 03 | [Conduct rules](03-conduct.md) | Medium | 00 | Drafted |
| 04 | [Head-to-head comparison](04-head-to-head.md) | Medium | 00, 01 for parts | Drafted |
| 05 | [Badges](05-badges.md) | Medium | 01 for lobby and variance badges | Drafted |
| 06 | [Identity signals](06-identity.md) | Small | 00 | Drafted |

## Order

1. **00** ships first so the new data starts collecting. The site must accept
   the new log format before the new Workshop script is published.
2. **01** is built and backtested in parallel, using the existing per-round
   kills. Launch ends the seed round of the current formula ELO.
3. **03** can ship first: it needs only a small importer change that skips
   `#` lines. Warnings only for the first week.
4. **02**, **04**, **05** and **06** follow. Parts of 04 and 05 that need only
   existing data can ship earlier.

See [data flow](../architecture.md) for where each step runs and the
[target schema](../schema.md) for the database once all briefs are built.
