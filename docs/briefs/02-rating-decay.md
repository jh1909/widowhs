# 02 · Rating decay

## Goal

Keep the leaderboard current: players who stop playing slide down it, and
the SR scale stays stable over time.

## Decisions

- **Decay through uncertainty, not points.** Each day without a weighted round
  increases a player's uncertainty. Their SR estimate is unchanged, but the
  leaderboard ranks by SR minus twice the uncertainty, so an inactive player
  slides gradually.
- **Pace:** after about 90 days without playing, uncertainty is back at the
  unplaced level, so the player drops off the leaderboard until they play
  again.
- **Returning players** recover quickly: high uncertainty means their first
  rounds back move their rating, and their range, fast.
- **No flat deflation tax.** The winner's bonus is zero-sum
  ([01](01-skill-rating.md)), so there is no built-in inflation to offset.
- **Drift monitor.** The mean SR of active players (a weighted round in the
  last 30 days) is recorded daily. If it moves more than 25 SR in 90 days,
  the scale is re-anchored by shifting every rating by the same amount, which
  keeps every gap between players unchanged.

## Scope

- Daily uncertainty growth (or computed at read time from the last round
  date).
- Leaderboard and profile use the decayed uncertainty; the profile notes
  "inactive for N days".
- Drift metric stored daily and shown in Admin.
- The re-anchor action, recorded in the audit log.

## Done when

- A player inactive for 30, 60 and 90 days ranks progressively lower and is
  unplaced at 90.
- One round back moves an inactive player's range visibly more than an
  active player's.
- The drift metric is visible in Admin; re-anchoring preserves every rating
  gap.

Size: **small**. Depends on [01](01-skill-rating.md).
