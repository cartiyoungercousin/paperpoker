import { test } from "node:test";
import assert from "node:assert/strict";
import { BettingRound } from "../src/bettingRound.js";
import { computePots } from "../src/pots.js";

function makeRound(stacks, minRaise = 2) {
  const players = Object.entries(stacks).map(([id, stack]) => ({ id, stack }));
  return new BettingRound({ players, minRaise });
}

test("everyone checking closes the round with no chips in the pot", () => {
  const round = makeRound({ a: 100, b: 100, c: 100 });
  round.applyAction("a", "check");
  round.applyAction("b", "check");
  round.applyAction("c", "check");
  assert.ok(round.isComplete());
  assert.equal(round.currentBet, 0);
});

test("cannot check when there is a bet to call", () => {
  const round = makeRound({ a: 100, b: 100 });
  round.applyAction("a", "bet", 10);
  assert.throws(() => round.applyAction("b", "check"));
});

test("cannot raise below the minimum raise size", () => {
  const round = makeRound({ a: 100, b: 100 }, 10);
  round.applyAction("a", "bet", 10);
  // minimum raise-to would be 20 (currentBet 10 + minRaise 10)
  assert.throws(() => round.applyAction("b", "raise", 15));
});

test("standard heads-up betting round: bet, call, round complete", () => {
  const round = makeRound({ a: 100, b: 100 });
  round.applyAction("a", "bet", 10);
  assert.equal(round.isComplete(), false);
  round.applyAction("b", "call");
  assert.ok(round.isComplete());

  const contributions = round.contributions();
  assert.equal(contributions.find((p) => p.id === "a").contributed, 10);
  assert.equal(contributions.find((p) => p.id === "b").contributed, 10);
});

test("a raise reopens action and round only completes once everyone matches", () => {
  const round = makeRound({ a: 100, b: 100, c: 100 }, 2);
  round.applyAction("a", "bet", 10);
  round.applyAction("b", "call");
  round.applyAction("c", "raise", 30);
  assert.equal(round.isComplete(), false, "a and b still need to respond to c's raise");

  round.applyAction("a", "call");
  assert.equal(round.isComplete(), false, "b still hasn't matched the raise");

  round.applyAction("b", "call");
  assert.ok(round.isComplete());
});

test("folding down to one player ends the round immediately", () => {
  const round = makeRound({ a: 100, b: 100, c: 100 });
  round.applyAction("a", "bet", 10);
  round.applyAction("b", "fold");
  round.applyAction("c", "fold");
  assert.ok(round.isComplete());
});

test("short all-in call creates a correct side pot when combined with computePots", () => {
  // b is short-stacked and can only call part of a's bet
  const round = makeRound({ a: 100, b: 15, c: 100 }, 2);
  round.applyAction("a", "bet", 20);

  const bLegal = round.legalActions("b");
  assert.equal(bLegal.callAmount, 15, "b can only call up to their whole stack");

  round.applyAction("b", "call"); // b goes all-in for 15
  assert.equal(round.getPlayer("b").allIn, true);
  assert.equal(round.isComplete(), false, "c still needs to act");

  round.applyAction("c", "call");
  assert.ok(round.isComplete());

  const pots = computePots(round.contributions());
  assert.equal(pots.length, 2);
  assert.equal(pots[0].amount, 45); // 15 * 3 players, main pot
  assert.deepEqual(new Set(pots[0].eligiblePlayerIds), new Set(["a", "b", "c"]));
  assert.equal(pots[1].amount, 10); // (20-15) * 2 players, side pot
  assert.deepEqual(new Set(pots[1].eligiblePlayerIds), new Set(["a", "c"]));
});

test("cannot act out of turn", () => {
  const round = makeRound({ a: 100, b: 100 });
  round.applyAction("a", "bet", 10);
  assert.throws(() => round.applyAction("a", "raise", 20), /not a's turn/);
});
