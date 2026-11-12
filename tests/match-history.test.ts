import assert from "node:assert/strict";
import test from "node:test";
import {
  groupSessions,
  byJoinTime,
  aggregateSessions,
} from "../src/lib/match-history.ts";

test("groupSessions groups rows sharing key in first-seen order", () => {
  const input = [
    { player: "Alice", id: 1 },
    { player: "Bob", id: 2 },
    { player: "Alice", id: 3 },
    { player: "Charlie", id: 4 },
    { player: "Bob", id: 5 },
  ];

  const grouped = groupSessions(input, (row) => row.player);
  assert.equal(grouped.length, 3);
  assert.deepEqual(
    grouped[0].map((r) => r.id),
    [1, 3]
  );
  assert.deepEqual(
    grouped[1].map((r) => r.id),
    [2, 5]
  );
  assert.deepEqual(
    grouped[2].map((r) => r.id),
    [4]
  );
});

test("byJoinTime orders sessions by join time ascending", () => {
  const sessions = [
    { name: "S3", join_time: 120 },
    { name: "S1", join_time: 0 },
    { name: "S2", join_time: 60 },
    { name: "S_null", join_time: null },
  ];

  const sorted = byJoinTime(sessions);
  assert.deepEqual(
    sorted.map((s) => s.name),
    ["S1", "S_null", "S2", "S3"]
  );
});

test("aggregateSessions preserves single session without modification", () => {
  const session = {
    score: 25,
    deaths: 5,
    kdr: 5,
    kpm: 12.5,
    accuracy: 45.2,
    crouches: 30,
    join_time: 10,
    end_time: 130,
    active_time: 120,
    time_in_lobby: 120,
    performance_score: 1500,
  };

  const aggregated = aggregateSessions([session]);
  assert.deepEqual(aggregated, session);
});

test("aggregateSessions combines multiple player sessions accurately", () => {
  const session1 = {
    player_name: "WidowMain",
    score: 20,
    deaths: 4,
    accuracy: 50.0,
    kpm: 10.0,
    kdr: 5.0,
    crouches: 15,
    join_time: 0,
    end_time: 120,
    active_time: 120,
    time_in_lobby: 120,
    performance_score: 1400,
  };

  const session2 = {
    player_name: "WidowMain",
    score: 30,
    deaths: 6,
    accuracy: 60.0,
    kpm: 10.0,
    kdr: 5.0,
    crouches: 25,
    join_time: 140,
    end_time: 320,
    active_time: 180,
    time_in_lobby: 180,
    performance_score: 1600,
  };

  const aggregated = aggregateSessions([session1, session2]);

  assert.equal(aggregated.score, 50);
  assert.equal(aggregated.deaths, 10);
  assert.equal(aggregated.crouches, 40);
  assert.equal(aggregated.kdr, 5.0); // 50 / 10
  assert.equal(aggregated.active_time, 300); // 120 + 180
  assert.equal(aggregated.time_in_lobby, 300);
  assert.equal(aggregated.join_time, 0); // first join
  assert.equal(aggregated.end_time, 320); // latest end
  assert.equal(aggregated.kpm, 10.0); // 50 kills in 300s (5 min) = 10.0
  // Accuracy: weighted by active_time: (50 * 120 + 60 * 180) / 300 = (6000 + 10800) / 300 = 16800 / 300 = 56.0
  assert.equal(aggregated.accuracy, 56.0);
  assert.equal(aggregated.performance_score, 1500); // (1400 + 1600) / 2
});

test("aggregateSessions gracefully handles legacy records without active_time", () => {
  const session1 = {
    player_name: "LegacyPlayer",
    score: 10,
    deaths: 2,
    accuracy: "40",
    kpm: "5",
    kdr: "5",
    crouches: 10,
    join_time: null,
    end_time: null,
    active_time: null,
    time_in_lobby: 120,
    performance_score: 1200,
  };

  const session2 = {
    player_name: "LegacyPlayer",
    score: 15,
    deaths: 3,
    accuracy: "60",
    kpm: "5",
    kdr: "5",
    crouches: 20,
    join_time: null,
    end_time: null,
    active_time: null,
    time_in_lobby: 180,
    performance_score: 1400,
  };

  const aggregated = aggregateSessions([session1, session2]);

  assert.equal(aggregated.score, 25);
  assert.equal(aggregated.deaths, 5);
  assert.equal(aggregated.crouches, 30);
  assert.equal(aggregated.kdr, 5.0);
  assert.equal(aggregated.active_time, 300); // falls back to time_in_lobby sum
  assert.equal(aggregated.time_in_lobby, 300);
  assert.equal(aggregated.kpm, 5.0); // 25 / (300/60) = 5.0
  // Accuracy: weighted by time_in_lobby fallback: (40 * 120 + 60 * 180) / 300 = 52.0
  assert.equal(aggregated.accuracy, 52.0);
  assert.equal(aggregated.performance_score, 1300);
});
