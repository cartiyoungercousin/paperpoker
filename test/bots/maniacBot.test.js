import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../../src/hand.js";
import { getManiacAction } from "../../src/bots/maniacBot.js";

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

test("getManiacAction always returns a legal action, across many random hands and table sizes", () => {
  for (let trial = 0; trial < 60; trial++) {
    const numPlayers = 2 + (trial % 5);
    const players = [{ id: "You", stack: 500 }];
    for (let i = 1; i < numPlayers; i++) players.push({ id: `Maniac_${i}`, stack: 500 });

    const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: trial % numPlayers });

    let guard = 0;
    while (!hand.complete && guard++ < 200) {
      const actingId = hand.actingPlayerId();
      const legal = hand.legalActions(actingId);
      if (actingId === "You") {
        hand.applyAction("You", legal.check ? "check" : "call");
        continue;
      }
      const decision = getManiacAction(actingId, hand);
      assertLegal(decision, legal);
      hand.applyAction(actingId, decision.action, decision.amount);
    }
    assert.ok(hand.complete, "hand should reach completion, not stall or loop forever");
  }
});

test("getManiacAction bets/raises far more often than it checks/calls passively, across many draws", () => {
  const players = [{ id: "You", stack: 5000 }, { id: "Maniac_1", stack: 5000 }];
  const hand = new Hand({ players, minRaise: 10, smallBlind: 5, bigBlind: 10, dealerIndex: 0 });
  hand.applyAction("You", "call"); // "You" limps preflop, action moves to Maniac_1 (BB) with a check option

  let aggressiveCount = 0;
  const trials = 200;
  for (let i = 0; i < trials; i++) {
    const decision = getManiacAction("Maniac_1", hand);
    if (decision.action === "bet" || decision.action === "raise") aggressiveCount++;
  }
  assert.ok(aggressiveCount > trials * 0.5, `expected most draws to be aggressive, got ${aggressiveCount}/${trials}`);
});
