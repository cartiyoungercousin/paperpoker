import { test } from "node:test";
import assert from "node:assert/strict";
import { computePots } from "../src/pots.js";

test("single pot when no one is all-in", () => {
  const pots = computePots([
    { id: "a", contributed: 50, folded: false },
    { id: "b", contributed: 50, folded: false },
    { id: "c", contributed: 50, folded: false },
  ]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 150);
  assert.deepEqual(new Set(pots[0].eligiblePlayerIds), new Set(["a", "b", "c"]));
});

test("creates a side pot when one player is all-in for less", () => {
  // a is all-in for 50, b and c both put in 150
  const pots = computePots([
    { id: "a", contributed: 50, folded: false },
    { id: "b", contributed: 150, folded: false },
    { id: "c", contributed: 150, folded: false },
  ]);
  assert.equal(pots.length, 2);

  assert.equal(pots[0].amount, 150); // 50 * 3 players
  assert.deepEqual(new Set(pots[0].eligiblePlayerIds), new Set(["a", "b", "c"]));

  assert.equal(pots[1].amount, 200); // 100 * 2 players
  assert.deepEqual(new Set(pots[1].eligiblePlayerIds), new Set(["b", "c"]));

  const total = pots.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(total, 350);
});

test("folded player's chips count toward the pot but they're not eligible to win", () => {
  const pots = computePots([
    { id: "a", contributed: 50, folded: false },
    { id: "b", contributed: 150, folded: true },
    { id: "c", contributed: 150, folded: false },
  ]);

  const total = pots.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(total, 350);

  for (const pot of pots) {
    assert.ok(!pot.eligiblePlayerIds.includes("b"), "folded player should never be eligible");
  }
});
