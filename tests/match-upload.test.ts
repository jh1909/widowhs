import assert from "node:assert/strict";
import test from "node:test";
import Papa from "papaparse";
import { normalizeMatchLog, parseMatchRows } from "../supabase/functions/upload-csv/parser.ts";
import { buildMatchImport } from "../supabase/functions/_shared/import-stats.ts";

function parse(text: string) {
  const result = Papa.parse<string[]>(normalizeMatchLog(text), {
    delimiter: ",", header: false, skipEmptyLines: "greedy",
  });
  assert.deepEqual(result.errors, []);
  return parseMatchRows(result.data);
}

const sample = [
  "[00:04:38] FearMyHanzo,0,1,0,0,0,0,4,271",
  "[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271",
  "[00:04:39] NZT,50,18,43.90,11.04,2.78,41,271,271",
  "[00:04:39] JohnPork,11,13,38.71,2.43,0.85,1,271,271",
  "[00:04:39] nicegirl,13,26,23.08,2.87,0.50,2,271,271",
  "[00:04:39] GateKeep,48,14,40.31,10.60,3.43,133,271,271",
];

test("imports all six supplied TXT records with Unicode names and distinct durations", () => {
  const matches = parse(sample.join("\r\n"));
  assert.equal(matches.length, 6);
  assert.deepEqual(matches[1], {
    player_name: "Лев", score: 5, deaths: 15, accuracy: 10.2,
    kpm: 1.77, kdr: 0.33, crouches: 9, time_in_lobby: 169, total_match_time: 271,
  });
  assert.equal(matches[0].score, 0);
  assert.equal(matches[0].time_in_lobby, 4);
  assert.ok(matches.every((match) => match.total_match_time === 271));
});

test("accepts timestamped records on the same line", () => {
  assert.deepEqual(parse(sample.join(" ")), parse(sample.join("\n")));
});

test("preserves legacy CSV decimal lobby time, BOM, headers and quoted player names", () => {
  const matches = parse('\uFEFFPlayer,kills,deaths,accuracy,kills/min,KDR,crouches,time in lobby\r\n"Hanzo, Jr",5,2,40,1.25,2.5,0,169.75\r\n\r\n');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].player_name, "Hanzo, Jr");
  assert.equal(matches[0].time_in_lobby, 169.75);
  assert.equal(matches[0].total_match_time, null);
});

test("accepts new CSV without timestamps", () => {
  assert.deepEqual(parse(sample[0].replace("[00:04:38] ", "")), parse(sample[0]));
});

test("rejects incomplete or malformed stats instead of recording zeroes", () => {
  assert.throws(() => parse("NZT,50,18"), /expected 8 or 9 columns/);
  assert.throws(() => parse("NZT,invalid,18,43.90,11.04,2.78,41,271,271"), /invalid number/);
  assert.throws(() => parse("NZT,50,18,43.90,11.04,2.78,41,,271"), /invalid number/);
  assert.throws(() => parse("NZT,50,18,43.90,11.04,2.78,41,271,271.5"), /whole seconds/);
});

test("ignores empty files and Unknown player placeholders", () => {
  assert.deepEqual(parse("\uFEFF\r\n \r\n"), []);
  assert.deepEqual(parse("Unknown,0,0,0,0,0,0,0,271"), []);
});

test("accepts v2 workshop logs with #R summary, #P player sessions and trailer header", () => {
  const log = [
    "[00:02:31] #R,144,Klog",
    "[00:02:31] #P,Klog,50,5,71.23,20.73,10,45,0,144,144,144",
    "[00:02:31] #P,Widowmaker,6,4,54.55,5.71,1.50,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,2,6,18.18,1.90,0.33,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,6,4,54.55,5.71,1.50,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,4,5,44.44,3.81,0.80,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,4,5,44.44,3.81,0.80,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,5,2,35.71,4.76,2.50,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,1,4,18.18,0.95,0.25,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,4,5,44.44,3.81,0.80,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,1,5,11.11,0.95,0.20,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,4,2,29.41,3.81,2,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,4,3,46.15,3.81,1.33,0,0,63,63,63",
    "[00:02:31] #P,Widowmaker,0,1,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,4,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,5,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,3,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,5,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,1,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,5,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,5,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,8,0,0,0,0,64,144,80,80",
    "[00:02:31] #P,Widowmaker,0,3,0,0,0,0,64,144,79,79",
    "[00:02:31] #P,Widowmaker,0,1,0,0,0,0,64,144,79,79",
    "name, kills, deaths, accuracy, kills/min, KDR, crouches, join time, end time, time in lobby, active time",
  ].join("\n");
  const matches = parse(log);
  assert.equal(matches.length, 23);
  assert.deepEqual(matches[0], {
    player_name: "Klog", score: 50, deaths: 5, accuracy: 71.23,
    kpm: 20.73, kdr: 10, crouches: 45, join_time: 0, end_time: 144,
    time_in_lobby: 144, active_time: 144, total_match_time: 144,
    round_winner: "Klog",
  });
  assert.deepEqual(matches[1], {
    player_name: "Widowmaker", score: 6, deaths: 4, accuracy: 54.55,
    kpm: 5.71, kdr: 1.5, crouches: 0, join_time: 0, end_time: 63,
    time_in_lobby: 63, active_time: 63, total_match_time: 144,
    round_winner: "Klog",
  });
  assert.deepEqual(matches[12], {
    player_name: "Widowmaker", score: 0, deaths: 1, accuracy: 0,
    kpm: 0, kdr: 0, crouches: 0, join_time: 64, end_time: 144,
    time_in_lobby: 80, active_time: 80, total_match_time: 144,
    round_winner: "Klog",
  });
  assert.ok(matches.every((m) => m.total_match_time === 144));
  assert.ok(matches.every((m) => m.round_winner === "Klog"));
});

test("accepts plain 11-column CSV without #P and derives duration from max end time", () => {
  const csv = [
    "name, kills, deaths, accuracy, kills/min, KDR, crouches, join time, end time, time in lobby, active time",
    "Klog,50,5,71.23,20.73,10,45,0,144,144,144",
    "Widowmaker,6,4,54.55,5.71,1.50,0,0,63,63,63",
  ].join("\r\n");
  const matches = parse(csv);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].total_match_time, 144);
  assert.equal(matches[1].total_match_time, 144);
  assert.equal(matches[0].join_time, 0);
  assert.equal(matches[0].end_time, 144);
  assert.equal(matches[0].active_time, 144);
});

test("ignores workshop metadata tags such as #V, #K, and #C", () => {
  const log = [
    "#V,2,1.0.0",
    "#R,144,Klog",
    "#P,Klog,50,5,71.23,20.73,10,45,0,144,144,144",
    "#K,Klog,Widowmaker,12",
    "#C,Widowmaker,afk,warn,10",
  ].join("\n");
  const matches = parse(log);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].player_name, "Klog");
});

test("buildMatchImport processes v2 records and retains new session properties in match rows", () => {
  const log = [
    "[00:02:31] #R,144,Klog",
    "[00:02:31] #P,Klog,50,5,71.23,20.73,10,45,0,144,144,144",
  ].join("\n");
  const parsed = parse(log);
  const importedMatches = parsed.map((m) => ({ ...m, played_at: "2026-11-12T01:00:00Z", match_id: "test-match" }));
  const result = buildMatchImport([], importedMatches);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].name, "Klog");
  assert.equal(result.players[0].personal_best_time, 144);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].join_time, 0);
  assert.equal(result.matches[0].end_time, 144);
  assert.equal(result.matches[0].active_time, 144);
  assert.equal(result.matches[0].round_winner, "Klog");
});
