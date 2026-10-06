import assert from "node:assert/strict";
import test from "node:test";
import { crouchesPerMinute, formatLobbyTime } from "../src/lib/profile-stats.ts";

test("crouches per minute weights a late join by actual lobby time", () => {
  // 30 crouches in 5 minutes + 6 in a late-joined 30 seconds = 36 / 5.5.
  assert.equal(crouchesPerMinute({ crouches: 36, time_in_lobby: 330 }), 36 / 5.5);
  assert.equal(crouchesPerMinute({ crouches: "6", time_in_lobby: "30" }), 12);
  assert.equal(crouchesPerMinute({ crouches: 0, time_in_lobby: 300 }), 0);
});

test("no playing time or invalid totals do not produce a misleading rate", () => {
  for (const time of [0, null, undefined, "", -1, NaN, Infinity]) {
    assert.equal(crouchesPerMinute({ crouches: 10, time_in_lobby: time }), null);
  }
  assert.equal(crouchesPerMinute({ crouches: -1, time_in_lobby: 60 }), null);
});

test("history durations distinguish missing legacy values from zero", () => {
  assert.equal(formatLobbyTime(169), "2:49");
  assert.equal(formatLobbyTime("271"), "4:31");
  assert.equal(formatLobbyTime(169.75), "2:49");
  assert.equal(formatLobbyTime(3601), "1:00:01");
  assert.equal(formatLobbyTime(0), "0:00");
  for (const time of [null, undefined, "", -1, NaN, Infinity]) {
    assert.equal(formatLobbyTime(time), "—");
  }
});
