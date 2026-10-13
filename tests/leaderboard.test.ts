import assert from "node:assert/strict";
import test from "node:test";
import { numericElo, rankPlayers, recordHolder } from "../supabase/functions/_shared/leaderboard.ts";

test("replaces duplicate stored ranks with positions ordered by numeric ELO", () => {
  const players = [
    { name: "Low", elo: "950", rank: 1 },
    { name: "High", elo: "1,200", rank: 1 },
    { name: "Middle", elo: 1000, rank: 2 },
  ];
  const ranked = rankPlayers(players);
  assert.deepEqual(ranked.map((p) => [p.name, p.rank]), [["High", 1], ["Middle", 2], ["Low", 3]]);
  assert.equal(players[0].rank, 1);
  assert.equal(players[0].name, "Low");
});

test("partial imports rank against unchanged players, including the existing leader", () => {
  const ranked = rankPlayers([
    { name: "ExistingLeader", elo: "1,600", rank: 1 },
    { name: "ExistingPlayer", elo: "900", rank: 2 },
    { name: "UploadedPlayer", elo: "1,200", rank: 1 },
  ]);
  assert.deepEqual(ranked.map((p) => [p.name, p.rank]), [
    ["ExistingLeader", 1], ["UploadedPlayer", 2], ["ExistingPlayer", 3],
  ]);
});

test("equal ELOs have deterministic unique ranks regardless of input order", () => {
  const players = [{ name: "Zed", elo: "1,000" }, { name: "alice", elo: 1000 }];
  assert.deepEqual(rankPlayers(players), rankPlayers([...players].reverse()));
  assert.deepEqual(rankPlayers(players).map((p) => [p.name, p.rank]), [["alice", 1], ["Zed", 2]]);
});

test("unranked profiles do not displace ranked players, while zero ELO stays valid", () => {
  const ranked = rankPlayers([
    { name: "NewProfile", elo: "-" },
    { name: "Missing", elo: null },
    { name: "Zero", elo: "0" },
    { name: "Invalid", elo: "NaN" },
    { name: "Empty", elo: " " },
  ]);
  assert.deepEqual(ranked.map((p) => [p.name, p.rank]), [["Zero", 1]]);
  assert.equal(numericElo("1,234"), 1234);
  assert.equal(numericElo(Infinity), null);
});

test("search and pagination preserve the global position", () => {
  const players = Array.from({ length: 15 }, (_, i) => ({ name: `Player${i}`, elo: 1500 - i }));
  const ranked = rankPlayers(players.reverse());
  assert.equal(ranked.filter((p) => p.name === "Player12")[0].rank, 13);
  assert.deepEqual(ranked.slice(10).map((p) => p.rank), [11, 12, 13, 14, 15]);
});

test("ELO stays primary, then faster personal playing time beats alphabetical order", () => {
  const ranked = rankPlayers([
    { name: "Alice", elo: 1000, personal_best_time: 180 },
    { name: "Zed", elo: "1,000", personal_best_time: "120" },
    { name: "HigherElo", elo: 1001, personal_best_time: 300 },
    { name: "NoWin", elo: 1000, personal_best_time: null },
  ]);
  assert.deepEqual(ranked.map(p => p.name), ["HigherElo", "Zed", "Alice", "NoWin"]);
});

test("missing, zero, negative and non-finite PBs cannot beat an actual win", () => {
  const values = [null, undefined, 0, -1, NaN, Infinity, "", "-"];
  const players = values.map((personal_best_time, i) => ({ name: `Unknown${i}`, elo: 1000, personal_best_time }));
  const ranked = rankPlayers([...players, { name: "Winner", elo: 1000, personal_best_time: 1000 }]);
  assert.equal(ranked[0].name, "Winner");
  assert.equal(ranked.length, players.length + 1);
});

test("equal PBs retain deterministic unique ranks after search or pagination", () => {
  const players = [{ name: "Zed", elo: 1000, personal_best_time: 100 }, { name: "alice", elo: 1000, personal_best_time: 100 }];
  assert.deepEqual(rankPlayers(players), rankPlayers([...players].reverse()));
  assert.deepEqual(rankPlayers(players).map(p => [p.name, p.rank]), [["alice", 1], ["Zed", 2]]);
});

test("the record holder includes players still in placements and ignores invalid records", () => {
  const players = [
    { name: "Ranked", elo: 1500, matches: 30, personal_best_time: 120 },
    { name: "NewRecord", elo: 900, matches: 1, personal_best_time: 90 },
    { name: "NoRecord", elo: 2000, matches: 30, personal_best_time: 0 },
  ];
  assert.equal(recordHolder(players)?.name, "NewRecord");
  assert.equal(recordHolder([]), null);
  assert.equal(recordHolder([{ name: "Unknown", elo: "-", personal_best_time: null }]), null);
});
