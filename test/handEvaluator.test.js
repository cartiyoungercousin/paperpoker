import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate5, compareScores, bestOf7, CATEGORY } from "../src/handEvaluator.js";
import { resolveShowdown } from "../src/showdown.js";

function c(rank, suit) {
  return { rank, suit };
}

test("recognizes a flush", () => {
  const hand = [c(2, "h"), c(5, "h"), c(9, "h"), c(11, "h"), c(14, "h")];
  const score = evaluate5(hand);
  assert.equal(score[0], CATEGORY.FLUSH);
});

test("recognizes a straight, including the wheel (A-2-3-4-5)", () => {
  const normalStraight = [c(6, "h"), c(7, "d"), c(8, "c"), c(9, "s"), c(10, "h")];
  assert.equal(evaluate5(normalStraight)[0], CATEGORY.STRAIGHT);

  const wheel = [c(14, "h"), c(2, "d"), c(3, "c"), c(4, "s"), c(5, "h")];
  const wheelScore = evaluate5(wheel);
  assert.equal(wheelScore[0], CATEGORY.STRAIGHT);
  assert.equal(wheelScore[1], 5, "wheel straight should be high-carded as a 5, not an ace");
});

test("full house beats flush beats straight", () => {
  const fullHouse = evaluate5([c(9, "h"), c(9, "d"), c(9, "c"), c(4, "s"), c(4, "h")]);
  const flush = evaluate5([c(2, "h"), c(5, "h"), c(9, "h"), c(11, "h"), c(13, "h")]);
  const straight = evaluate5([c(6, "h"), c(7, "d"), c(8, "c"), c(9, "s"), c(10, "h")]);

  assert.ok(compareScores(fullHouse, flush) > 0, "full house should beat flush");
  assert.ok(compareScores(flush, straight) > 0, "flush should beat straight");
});

test("four of a kind beats full house", () => {
  const quads = evaluate5([c(9, "h"), c(9, "d"), c(9, "c"), c(9, "s"), c(4, "h")]);
  const fullHouse = evaluate5([c(9, "h"), c(9, "d"), c(9, "c"), c(4, "s"), c(4, "h")]);
  assert.ok(compareScores(quads, fullHouse) > 0);
});

test("higher two pair beats lower two pair", () => {
  const aces_kings = evaluate5([c(14, "h"), c(14, "d"), c(13, "c"), c(13, "s"), c(2, "h")]);
  const queens_jacks = evaluate5([c(12, "h"), c(12, "d"), c(11, "c"), c(11, "s"), c(2, "h")]);
  assert.ok(compareScores(aces_kings, queens_jacks) > 0);
});

test("bestOf7 finds the best 5-card hand out of 7 cards", () => {
  // Hole cards: pocket aces. Board gives a second pair of kings -> two pair, aces and kings.
  const sevenCards = [
    c(14, "h"), c(14, "d"), // hole
    c(13, "c"), c(13, "s"), c(2, "h"), c(5, "d"), c(9, "c"), // board
  ];
  const best = bestOf7(sevenCards);
  assert.equal(best.score[0], CATEGORY.TWO_PAIR);
  assert.equal(best.score[1], 14);
  assert.equal(best.score[2], 13);
});

test("resolveShowdown finds a single winner", () => {
  const board = [c(2, "c"), c(5, "d"), c(9, "h"), c(11, "s"), c(3, "c")];
  const players = [
    { id: "alice", holeCards: [c(14, "h"), c(14, "d")] }, // pair of aces
    { id: "bob", holeCards: [c(13, "h"), c(12, "d")] }, // king-queen high, no pair, no straight
  ];
  const { winnerIds } = resolveShowdown(players, board);
  assert.deepEqual(winnerIds, ["alice"]);
});

test("resolveShowdown splits the pot on an exact tie", () => {
  // Board itself is the best hand for both players (a straight on the board),
  // and both hole cards are irrelevant low cards that don't improve it.
  const board = [c(6, "h"), c(7, "d"), c(8, "c"), c(9, "s"), c(10, "h")];
  const players = [
    { id: "alice", holeCards: [c(2, "c"), c(3, "d")] },
    { id: "bob", holeCards: [c(2, "d"), c(3, "c")] },
  ];
  const { winnerIds } = resolveShowdown(players, board);
  assert.equal(winnerIds.length, 2);
  assert.ok(winnerIds.includes("alice") && winnerIds.includes("bob"));
});
