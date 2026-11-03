# 04 · Head-to-head comparison

## Goal

Let players compare themselves with any other player side by side: who does
better when both are in the same lobby. Some players are strongest against
top opponents without being the fastest at finishing lobbies, and this shows
it.

## Decisions

- **Entry:** a "Compare" action on every profile opens a player picker, then
  a shareable page at `#/compare/<player>/<player>`.
- **Fair shared round:** both players had at least 30 s in the round, and
  their time together covers at least 80% of the longer of their two
  sessions. In v1 rounds both were present at the end, so this is
  `shorter time ÷ longer time ≥ 0.8`. From v2 rounds the exact overlap is used
  ([00](00-logging-and-ingest.md)).
- **Periods:** last 7 days and all time.
- **Shot-level duel accuracy is not possible.** Logs cannot tell which player
  a shot was aimed at.

## Stats

Available from existing data:

- shared rounds
- finished ahead: count and percentage each
- wins in shared rounds: each player's count
- average kill share against each other, the same measure SR uses
- average kills in shared rounds
- average lobby strength of shared rounds (needs [01](01-skill-rating.md))

From SR ([01](01-skill-rating.md)):

- current SR and range side by side
- expected kill share between them from current ratings, next to the actual
- SR history of both on one chart

From v2 rounds only, labelled "since <date>":

- kills on each other: direct duel record
- on profiles: the five players who killed this player most and the five
  they killed most, as nemesis and favourite-target lists

## Engineering

- One server-side function returns all stats for a pair and a period.
- Index player participations by round so shared rounds are found cheaply.
- Pages state the fair-round rule and how many shared rounds back the
  numbers. With fewer than 5 shared rounds the comparison shows counts only,
  no percentages.

## Phasing

1. Shared rounds, finished ahead, wins, kill share and kills, from existing
   data. Can ship before SR.
2. SR, expected share and lobby strength once [01](01-skill-rating.md) is
   live.
3. Duel record and nemesis lists once v2 data has collected for two weeks.

## Done when

- Comparing two regulars shows correct counts against a hand-checked set of
  rounds, for both periods.
- Rounds failing the 30 s or 80% rule are excluded and the page says so.
- Each phase's stats appear as its data becomes available.

Size: **medium**.
