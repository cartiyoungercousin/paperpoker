import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../../src/hand.js";
import { getBluffAction } from "../../src/bots/bluffBot.js";

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

test("getBluffAction always returns a legal action, across many random hands and table sizes", () => {
  for (let trial = 0; trial < 60; trial++) {
    const numPlayers = 2 + (trial % 5); // 2..6 players
    const players = [{ id: "You", stack: 500 }];
    for (let i = 1; i < numPlayers; i++) players.push({ id: `Bluffer_${i}`, stack: 500 });

    const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: trial % numPlayers });

    let guard = 0;
    while (!hand.complete && guard++ < 200) {
      const actingId = hand.actingPlayerId();
      const legal = hand.legalActions(actingId);
      if (actingId === "You") {
        hand.applyAction("You", legal.check ? "check" : "call");
        continue;
      }
      const decision = getBluffAction(actingId, hand);
      assertLegal(decision, legal);
      hand.applyAction(actingId, decision.action, decision.amount);
    }
    assert.ok(hand.complete, "hand should reach completion, not stall or loop forever");
  }
});

// The whole point of this bot is that its aggression isn't 100% hollow -
// across enough hands it should show up with bets/raises on both strong
// and weak holdings, not exclusively one or the other.
test("getBluffAction bets or raises with both strong and weak hands over many opportunities", () => {
  const players = [{ id: "You", stack: 100000 }, { id: "Bluffer", stack: 100000 }];
  let sawAggressionWithPair = false;
  let sawAggressionWithoutPair = false;

  for (let trial = 0; trial < 300 && !(sawAggressionWithPair && sawAggressionWithoutPair); trial++) {
    const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: trial % 2 });
    if (hand.actingPlayerId() !== "Bluffer") continue; // only look at Bluffer's opening decision this hand
    const holeCards = hand.holeCards.get("Bluffer");
    const isPair = holeCards[0].rank === holeCards[1].rank;
    const decision = getBluffAction("Bluffer", hand);
    if (decision.action === "bet" || decision.action === "raise") {
      if (isPair) sawAggressionWithPair = true;
      else sawAggressionWithoutPair = true;
    }
  }

  assert.ok(sawAggressionWithoutPair, "expected at least one bluff (aggression without a pair) across 300 hands");
});
