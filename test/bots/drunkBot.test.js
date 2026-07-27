import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../../src/hand.js";
import { getDrunkAction } from "../../src/bots/drunkBot.js";

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

// Plays out many full hands where every bot seat is the Drunk, checking/
// calling the human seat forward so the hand actually reaches completion,
// and asserting on every single Drunk decision along the way - across
// enough random hands to exercise preflop, multiway, and heads-up-on-a-
// side-pot situations without ever throwing or returning an illegal action.
test("getDrunkAction always returns a legal action, across many random hands and table sizes", () => {
  for (let trial = 0; trial < 60; trial++) {
    const numPlayers = 2 + (trial % 5); // 2..6 players
    const players = [{ id: "You", stack: 500 }];
    for (let i = 1; i < numPlayers; i++) players.push({ id: `Drunk_${i}`, stack: 500 });

    const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: trial % numPlayers });

    let guard = 0;
    while (!hand.complete && guard++ < 200) {
      const actingId = hand.actingPlayerId();
      const legal = hand.legalActions(actingId);
      if (actingId === "You") {
        hand.applyAction("You", legal.check ? "check" : "call");
        continue;
      }
      const decision = getDrunkAction(actingId, hand);
      assertLegal(decision, legal);
      hand.applyAction(actingId, decision.action, decision.amount);
    }
    assert.ok(hand.complete, "hand should reach completion, not stall or loop forever");
  }
});
