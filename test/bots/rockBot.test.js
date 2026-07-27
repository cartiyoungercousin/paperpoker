import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../../src/hand.js";
import { getRockAction } from "../../src/bots/rockBot.js";

function assertLegal(decision, legal) {
  assert.ok(decision, "the bot should always return a decision when it's legally its turn");
  assert.ok(["fold", "check", "call", "bet", "raise"].includes(decision.action));
  if (decision.action === "check") assert.ok(legal.check, "returned check when check wasn't legal");
  if (decision.action === "call") assert.ok(legal.call, "returned call when call wasn't legal");
  if (decision.action === "bet") {
    assert.ok(legal.bet, "returned bet when bet wasn't legal");
    assert.ok(decision.amount >= legal.minRaiseTo && decision.amount <= legal.maxRaiseTo, "bet amount out of the legal range");
  }
  if (decision.action === "raise") {
    assert.ok(legal.raise, "returned raise when raise wasn't legal");
    assert.ok(decision.amount >= legal.minRaiseTo && decision.amount <= legal.maxRaiseTo, "raise amount out of the legal range");
  }
}

// The Rock is a 1v1-only archetype, but its decision function itself doesn't
// enforce that (TableGame/server does, separately) - exercised across
// several table sizes anyway, same convention as the other bot tests, to
// confirm it never returns an illegal action regardless.
test("getRockAction always returns a legal action, across many random hands and table sizes", () => {
  for (let trial = 0; trial < 60; trial++) {
    const numPlayers = 2 + (trial % 5);
    const players = [{ id: "You", stack: 500 }];
    for (let i = 1; i < numPlayers; i++) players.push({ id: `Rock_${i}`, stack: 500 });

    const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: trial % numPlayers });

    let guard = 0;
    while (!hand.complete && guard++ < 200) {
      const actingId = hand.actingPlayerId();
      const legal = hand.legalActions(actingId);
      if (actingId === "You") {
        hand.applyAction("You", legal.check ? "check" : "call");
        continue;
      }
      const decision = getRockAction(actingId, hand);
      assertLegal(decision, legal);
      hand.applyAction(actingId, decision.action, decision.amount);
    }
    assert.ok(hand.complete, "hand should reach completion, not stall or loop forever");
  }
});

test("getRockAction folds a weak preflop hand facing a raise rather than calling it off", () => {
  const players = [{ id: "You", stack: 500 }, { id: "Rock_1", stack: 500 }];
  const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: 0 });
  // Force weak hole cards for the Rock seat regardless of the real deal.
  hand.holeCards.set("Rock_1", [{ rank: 2, suit: "c" }, { rank: 7, suit: "d" }]);
  // Heads-up: dealerIndex 0 ("You") is on the button and acts first preflop.
  assert.equal(hand.actingPlayerId(), "You");
  hand.applyAction("You", "raise", 60);

  assert.equal(hand.actingPlayerId(), "Rock_1");
  const decision = getRockAction("Rock_1", hand);
  assert.equal(decision.action, "fold");
});
