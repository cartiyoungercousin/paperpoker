import { test } from "node:test";
import assert from "node:assert/strict";
import { rankForXp, xpForHand, DIFFICULTY_XP, RANK_TIERS } from "../src/rankTiers.js";

test("RANK_TIERS is ordered by strictly increasing threshold, 16 tiers total", () => {
  assert.equal(RANK_TIERS.length, 16);
  for (let i = 1; i < RANK_TIERS.length; i++) {
    assert.ok(RANK_TIERS[i].threshold > RANK_TIERS[i - 1].threshold, `${RANK_TIERS[i].label} should be a higher threshold than ${RANK_TIERS[i - 1].label}`);
  }
});

test("rankForXp: 0 XP (a brand-new account) is Bronze III", () => {
  assert.equal(rankForXp(0).label, "Bronze III");
});

test("rankForXp: negative or missing XP is treated as 0 (still Bronze III, never throws)", () => {
  assert.equal(rankForXp(-500).label, "Bronze III");
  assert.equal(rankForXp(undefined).label, "Bronze III");
  assert.equal(rankForXp(null).label, "Bronze III");
});

test("rankForXp: boundary values land exactly on the tier they unlock, not the one before", () => {
  assert.equal(rankForXp(149).label, "Bronze III");
  assert.equal(rankForXp(150).label, "Bronze II");
  assert.equal(rankForXp(399).label, "Bronze II");
  assert.equal(rankForXp(400).label, "Bronze I");
});

test("rankForXp: the top tier (PokerProfessor) has no next tier and reports full progress", () => {
  const rank = rankForXp(48500);
  assert.equal(rank.label, "PokerProfessor");
  assert.equal(rank.sub, null);
  assert.equal(rank.nextLabel, null);
  assert.equal(rank.nextThreshold, null);
  assert.equal(rank.progress, 1);

  // Comfortably above the top threshold too - still PokerProfessor, not an error.
  assert.equal(rankForXp(1_000_000).label, "PokerProfessor");
});

test("rankForXp: progress toward the next tier is a fraction between 0 and 1", () => {
  const rank = rankForXp(75); // halfway from Bronze III (0) to Bronze II (150)
  assert.equal(rank.label, "Bronze III");
  assert.equal(rank.nextLabel, "Bronze II");
  assert.ok(Math.abs(rank.progress - 0.5) < 1e-9);
});

test("xpForHand: awards the configured win amount and deducts the configured loss amount, per difficulty", () => {
  for (const difficulty of Object.keys(DIFFICULTY_XP)) {
    const { win, loss } = DIFFICULTY_XP[difficulty];
    assert.equal(xpForHand(difficulty, true), win);
    assert.equal(xpForHand(difficulty, false), loss);
    assert.ok(win > 0, `${difficulty} win XP should be positive`);
    assert.ok(loss < 0, `${difficulty} loss XP should be negative`);
  }
});

test("xpForHand: harder difficulties award/deduct strictly larger XP swings", () => {
  const order = ["easy", "medium", "hard", "expert"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(DIFFICULTY_XP[order[i]].win > DIFFICULTY_XP[order[i - 1]].win, `${order[i]} win XP should exceed ${order[i - 1]}`);
    assert.ok(DIFFICULTY_XP[order[i]].loss < DIFFICULTY_XP[order[i - 1]].loss, `${order[i]} loss XP should be more negative than ${order[i - 1]}`);
  }
});

test("xpForHand: an unrecognized difficulty falls back to the easy table rather than throwing", () => {
  assert.equal(xpForHand("nonsense", true), DIFFICULTY_XP.easy.win);
  assert.equal(xpForHand("nonsense", false), DIFFICULTY_XP.easy.loss);
});

test("xpForHand: without potSize/startingStack, returns the flat base amount unscaled (existing callers keep working)", () => {
  assert.equal(xpForHand("medium", true), DIFFICULTY_XP.medium.win);
  assert.equal(xpForHand("medium", true, undefined, 1000), DIFFICULTY_XP.medium.win, "missing potSize alone should also skip scaling");
});

test("xpForHand: a pot equal to the starting stack scales XP by exactly 1x (no change)", () => {
  assert.equal(xpForHand("medium", true, 1000, 1000), DIFFICULTY_XP.medium.win);
  assert.equal(xpForHand("medium", false, 1000, 1000), DIFFICULTY_XP.medium.loss);
});

test("xpForHand: a small pot is floored at 0.25x the base amount, not scaled down to near zero", () => {
  // A tiny pot (1% of the starting stack) would be 0.01x unclamped - the
  // floor keeps even a min-bet hand worth something.
  const expected = Math.round(DIFFICULTY_XP.medium.win * 0.25);
  assert.equal(xpForHand("medium", true, 10, 1000), expected);
});

test("xpForHand: a huge pot is capped at 3x the base amount, not scaled up without bound", () => {
  // A pot 10x the starting stack (a multi-way monster or a re-buy scenario)
  // would be 10x unclamped - the cap keeps one hand from swinging a session.
  const expected = Math.round(DIFFICULTY_XP.medium.win * 3);
  assert.equal(xpForHand("medium", true, 10000, 1000), expected);
});

test("xpForHand: pot-scaling applies the same multiplier to a loss as to a win, for the same pot ratio", () => {
  // A half-stack pot -> 0.5x multiplier, applied to whichever base (win or
  // loss) is relevant - losing a bigger pot should cost more XP too.
  const potSize = 500, startingStack = 1000;
  assert.equal(xpForHand("medium", true, potSize, startingStack), Math.round(DIFFICULTY_XP.medium.win * 0.5));
  assert.equal(xpForHand("medium", false, potSize, startingStack), Math.round(DIFFICULTY_XP.medium.loss * 0.5));
});
