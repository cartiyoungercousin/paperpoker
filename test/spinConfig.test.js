import { test } from "node:test";
import assert from "node:assert/strict";
import { SPIN_COST, SPIN_SEGMENTS, SPIN_WEIGHT_TOTAL, pickSpinSegment } from "../src/spinConfig.js";

test("SPIN_COST is a positive integer", () => {
  assert.ok(Number.isInteger(SPIN_COST) && SPIN_COST > 0);
});

test("every segment has a unique key, a valid type, a positive amount, and a positive weight", () => {
  const seen = new Set();
  for (const s of SPIN_SEGMENTS) {
    assert.ok(!seen.has(s.key), `duplicate segment key ${s.key}`);
    seen.add(s.key);
    assert.ok(s.type === "coins" || s.type === "xp", `unexpected type ${s.type} for ${s.key}`);
    assert.ok(Number.isInteger(s.amount) && s.amount > 0);
    assert.ok(s.weight > 0);
    assert.equal(typeof s.label, "string");
  }
});

test("SPIN_WEIGHT_TOTAL is the sum of every segment's weight", () => {
  const sum = SPIN_SEGMENTS.reduce((a, s) => a + s.weight, 0);
  assert.equal(SPIN_WEIGHT_TOTAL, sum);
});

test("the average coin payout is comfortably below SPIN_COST - spinning purely for coins is a losing bet on average", () => {
  const coinEv = SPIN_SEGMENTS
    .filter((s) => s.type === "coins")
    .reduce((sum, s) => sum + s.amount * s.weight, 0) / SPIN_WEIGHT_TOTAL;
  assert.ok(coinEv < SPIN_COST, `coin EV (${coinEv}) should be below the ${SPIN_COST}-coin cost`);
});

test("pickSpinSegment always returns a segment/index pair that round-trips into SPIN_SEGMENTS", () => {
  for (let i = 0; i < 200; i++) {
    const { segment, index } = pickSpinSegment();
    assert.ok(index >= 0 && index < SPIN_SEGMENTS.length);
    assert.equal(SPIN_SEGMENTS[index], segment);
  }
});

test("pickSpinSegment's distribution roughly matches the configured weights over many trials", () => {
  const counts = new Map(SPIN_SEGMENTS.map((s) => [s.key, 0]));
  const trials = 20000;
  for (let i = 0; i < trials; i++) {
    const { segment } = pickSpinSegment();
    counts.set(segment.key, counts.get(segment.key) + 1);
  }
  for (const s of SPIN_SEGMENTS) {
    const expected = (s.weight / SPIN_WEIGHT_TOTAL) * trials;
    const actual = counts.get(s.key);
    // Generous tolerance (the rarest segment has weight 1/100 - expect ~200
    // hits in 20000 trials) - this is a sanity check on the weighting logic,
    // not a strict statistical test.
    assert.ok(Math.abs(actual - expected) < expected * 0.5 + 50, `${s.key}: expected ~${expected}, got ${actual}`);
  }
});
