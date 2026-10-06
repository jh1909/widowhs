import assert from "node:assert/strict";
import test from "node:test";
import { getAchievements, isSpeedrunnerMatch, totalKdr } from "../src/lib/achievements.ts";

const hasSlayer = (player: Parameters<typeof getAchievements>[0]) =>
  getAchievements(player).some((badge) => badge.id === "slayer");

test("Slayer uses the displayed total K/D, not the average of per-match ratios", () => {
  const player = { score: 190, deaths: 100, kdr: "2.85" };
  assert.equal(totalKdr(player), 1.9);
  assert.equal(hasSlayer(player), false);
});

test("Slayer disappears when K/D falls and returns when it rises again", () => {
  assert.equal(hasSlayer({ score: 220, deaths: 100 }), true);
  assert.equal(hasSlayer({ score: 240, deaths: 130 }), false);
  assert.equal(hasSlayer({ score: 300, deaths: 130 }), true);
});

test("Slayer threshold agrees with the displayed two-decimal K/D", () => {
  assert.equal(hasSlayer({ score: 200, deaths: 100 }), false);
  assert.equal(hasSlayer({ score: 2004, deaths: 1000 }), false);
  assert.equal(hasSlayer({ score: 2006, deaths: 1000 }), true);
  assert.equal(totalKdr({ score: "19", deaths: "10" }), 1.9);
  assert.equal(totalKdr({ score: 5, deaths: 0 }), 5);
  assert.equal(hasSlayer({}), false);
});

test("Speedrunner requires a 50-kill win and total duration strictly below 180 seconds", () => {
  assert.equal(isSpeedrunnerMatch({ score: 50, total_match_time: 179 }), true);
  assert.equal(isSpeedrunnerMatch({ score: "50", total_match_time: "179" }), true);
  assert.equal(isSpeedrunnerMatch({ score: 50, total_match_time: 180 }), false);
  assert.equal(isSpeedrunnerMatch({ score: 50, total_match_time: 181 }), false);
  assert.equal(isSpeedrunnerMatch({ score: 49, total_match_time: 179 }), false);
});

test("missing, invalid or legacy match duration never grants Speedrunner", () => {
  for (const duration of [null, undefined, 0, -1, "", "-", "NaN", NaN, Infinity]) {
    assert.equal(isSpeedrunnerMatch({ score: 50, total_match_time: duration }), false);
  }
  assert.equal(isSpeedrunnerMatch(null), false);
  const lateJoin = { score: 50, time_in_lobby: 100, total_match_time: 300 };
  assert.equal(isSpeedrunnerMatch(lateJoin), false);
});

test("a historic Speedrunner win remains earned regardless of current Slayer stats", () => {
  const winner = { score: 50, total_match_time: 170 };
  const badges = getAchievements({ score: 190, deaths: 100 }, winner);
  assert.equal(badges.some((badge) => badge.id === "speedrunner"), true);
  assert.equal(badges.some((badge) => badge.id === "slayer"), false);
  assert.equal(getAchievements({ score: 0, deaths: 0, rank: 999999 }, null).length, 0);
});

test("unranked and missing ranks cannot grant Top 10", () => {
  for (const rank of [undefined, null, "-", 0, -1, 999999]) {
    assert.equal(getAchievements({ rank }).some((badge) => badge.id === "elite"), false);
  }
  assert.equal(getAchievements({ rank: 10 }).some((badge) => badge.id === "elite"), true);
});
