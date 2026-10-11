import assert from "node:assert/strict";
import test from "node:test";
import { calculateRating } from "../supabase/functions/_shared/rating.ts";

test("rating uses 65% pace, 25% accuracy and 10% KDR", () => {
  assert.equal(calculateRating({ kpm: 16.67, accuracy: 0, kdr: 0 }), 650);
  assert.equal(calculateRating({ kpm: 0, accuracy: 60, kdr: 0 }), 250);
  assert.equal(calculateRating({ kpm: 0, accuracy: 0, kdr: 3 }), 100);
  assert.equal(calculateRating({ kpm: 16.67, accuracy: 60, kdr: 3 }), 1000);
  assert.equal(calculateRating({ kpm: 8.335, accuracy: 30, kdr: 1.5 }), 500);
});

test("pace caps at 1.67 and accuracy caps at 1.15", () => {
  assert.equal(calculateRating({ kpm: 100, accuracy: 0, kdr: 0 }), 1086);
  assert.equal(calculateRating({ kpm: 0, accuracy: 100, kdr: 0 }), 288);
});

test("KDR caps at 4.0 before dividing by 3", () => {
  for (const kdr of [4, 4.5, 10, 100]) {
    assert.equal(calculateRating({ kpm: 0, accuracy: 0, kdr }), 133);
  }
});

test("ratings round once after combining the factors", () => {
  assert.equal(calculateRating({ kpm: 0, accuracy: 0, kdr: 0 }), 0);
  assert.equal(calculateRating({ kpm: 11.04, accuracy: 43.9, kdr: 2.78 }), 706);
  assert.equal(calculateRating({ kpm: 100, accuracy: 100, kdr: 100 }), 1506);
});
