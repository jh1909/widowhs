import assert from "node:assert/strict";
import test from "node:test";
import Papa from "papaparse";
import { normalizeMatchLog, parseMatchRows } from "../supabase/functions/upload-csv/parser.ts";

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
