import assert from "node:assert/strict";
import test from "node:test";
import { getAchievements, isSpeedrunnerMatch } from "../src/lib/achievements.ts";
import { playerKdr, formatPlayerKdr } from "../src/lib/player-kdr.ts";

const hasSlayer = (player: Parameters<typeof getAchievements>[0]) =>
  getAchievements(player).some((badge) => badge.id === "slayer");

test("Sharpshooter awards only the highest tier with inclusive 40/50/60% boundaries", () => {
  for (const [accuracy, tier] of [[39.99, 0], [40, 1], [49.99, 1], [50, 2], [59.99, 2], [60, 3], [100, 3]]) {
    const badges = getAchievements({ accuracy: `${accuracy}%` }).filter(b => b.id === 'sharpshooter');
    assert.equal(badges.length, tier ? 1 : 0);
    assert.equal(badges[0]?.tier ?? 0, tier);
    if (tier) assert.equal(badges[0].name, `Sharpshooter ${['I','II','III'][tier - 1]}`);
  }
  for (const accuracy of [null, undefined, '', '-', NaN, Infinity, -1])
    assert.ok(!getAchievements({ accuracy }).some(b => b.id === 'sharpshooter'));
});

test("Speedrunner uses the lifetime count independent of current performance", () => {
  assert.equal(getAchievements({ speedrunner_count: '1234', recent_matches: 0 })
    .find(b => b.id === 'speedrunner')?.count, 1234);
  for (const speedrunner_count of [0, -1, NaN, Infinity, '-'])
    assert.ok(!getAchievements({ speedrunner_count }).some(b => b.id === 'speedrunner'));
});

test("profile and Slayer use the leaderboard K/D even when total kills/deaths differs", () => {
  const player = { score: 190, deaths: 100, kdr: "2.85" };
  assert.equal(playerKdr(player), 2.85);
  assert.equal(formatPlayerKdr(player), "2.85");
  assert.equal(hasSlayer(player), true);
  assert.equal(hasSlayer({ score: 300, deaths: 100, kdr: "1.90" }), false);
});

test("Slayer disappears when K/D falls and returns when it rises again", () => {
  assert.equal(hasSlayer({ kdr: "2.20" }), true);
  assert.equal(hasSlayer({ kdr: "1.90" }), false);
  assert.equal(hasSlayer({ kdr: "2.30" }), true);
});

test("Slayer threshold agrees with the displayed two-decimal K/D", () => {
  assert.equal(hasSlayer({ kdr: 2 }), false);
  assert.equal(hasSlayer({ kdr: 2.004 }), false);
  assert.equal(hasSlayer({ kdr: 2.006 }), true);
  assert.equal(playerKdr({ kdr: "1.90" }), 1.9);
  assert.equal(formatPlayerKdr({ kdr: 0 }), "0.00");
  for (const kdr of [null, undefined, "", "-", NaN, Infinity, -1]) {
    assert.equal(formatPlayerKdr({ kdr }), "—");
    assert.equal(hasSlayer({ kdr }), false);
  }
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

const hasSquatMaster = (player: Parameters<typeof getAchievements>[0]) =>
  getAchievements(player).some((badge) => badge.id === "fitness");

test("Squat Master rewards a current average of at least 100 crouches, not lifetime totals", () => {
  assert.equal(hasSquatMaster({ crouches: 100, matches: 1 }), true);
  assert.equal(hasSquatMaster({ crouches: "1000", matches: "10" }), true);
  assert.equal(hasSquatMaster({ crouches: 1500, matches: 30 }), false);
  assert.equal(hasSquatMaster({ crouches: 199, matches: 2 }), false);
  const badge = getAchievements({ crouches: 200, matches: 2 }).find((badge) => badge.id === "fitness");
  assert.equal(badge?.desc, "Average of 100+ crouches per match");
});

test("Squat Master disappears below the threshold and can be earned again", () => {
  assert.equal(hasSquatMaster({ crouches: 200, matches: 2 }), true);
  assert.equal(hasSquatMaster({ crouches: 200, matches: 3 }), false);
  assert.equal(hasSquatMaster({ crouches: 400, matches: 4 }), true);
});

test("missing or invalid match counts and crouch totals cannot grant Squat Master", () => {
  for (const matches of [0, null, undefined, "", "-", -1, NaN, Infinity]) {
    assert.equal(hasSquatMaster({ crouches: 10000, matches }), false);
  }
  for (const crouches of [null, undefined, "", "-", -1, NaN, Infinity]) {
    assert.equal(hasSquatMaster({ crouches, matches: 1 }), false);
  }
});

const hasNoCroucher = (player: Parameters<typeof getAchievements>[0]) =>
  getAchievements(player).some(badge => badge.id === "no-croucher");

test("No Croucher tolerates isolated misclicks up to 0.1 crouches per minute", () => {
  assert.equal(hasNoCroucher({ matches: 1, crouches: 0, time_in_lobby: 60 }), true);
  assert.equal(hasNoCroucher({ matches: 2, crouches: 1, time_in_lobby: 600 }), true);
  assert.equal(hasNoCroucher({ matches: "10", crouches: "2", time_in_lobby: "1200" }), true);
  assert.equal(hasNoCroucher({ matches: 2, crouches: 1, time_in_lobby: 599 }), false);
  assert.equal(hasNoCroucher({ matches: 2, crouches: 2, time_in_lobby: 600 }), false);
});

test("No Croucher uses cumulative playing time and disappears above the current threshold", () => {
  assert.equal(hasNoCroucher({ matches: 1, crouches: 1, time_in_lobby: 300 }), false);
  assert.equal(hasNoCroucher({ matches: 2, crouches: 1, time_in_lobby: 600 }), true);
  assert.equal(hasNoCroucher({ matches: 3, crouches: 2, time_in_lobby: 900 }), false);
  assert.equal(hasNoCroucher({ matches: 4, crouches: 2, time_in_lobby: 1200 }), true);
  const badge = getAchievements({ matches: 1, crouches: 0, time_in_lobby: 60 }).find(badge => badge.id === "no-croucher");
  assert.equal(badge?.name, "No Croucher");
  assert.equal(badge?.desc, "Average of 0.1 crouches/min or less");
});

test("No Croucher cannot be awarded to empty profiles or missing/invalid statistics", () => {
  for (const matches of [0, null, undefined, "", "-", -1, NaN, Infinity])
    assert.equal(hasNoCroucher({ matches, crouches: 0, time_in_lobby: 600 }), false);
  for (const time_in_lobby of [0, null, undefined, "", "-", -1, NaN, Infinity])
    assert.equal(hasNoCroucher({ matches: 1, crouches: 0, time_in_lobby }), false);
  for (const crouches of [null, undefined, "", "-", -1, NaN, Infinity])
    assert.equal(hasNoCroucher({ matches: 1, crouches, time_in_lobby: 600 }), false);
  assert.equal(hasNoCroucher({ matches: 0, crouches: 0, time_in_lobby: 0 }), false);
});
