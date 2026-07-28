import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../src/hand.js";
import { POWER_UPS_CATALOG } from "../src/powerUps.js";
import { decidePowerUpUse, pickOpponentTarget } from "../src/rumbleBotAI.js";

function c(rank, suit) { return { rank, suit }; }

function fixedDeck(cardsInDealOrder) {
  return {
    cards: [...cardsInDealOrder],
    draw(n = 1) { return this.cards.splice(0, n); },
    peek(n = 1) { return this.cards.slice(0, n); },
    remaining() { return this.cards.length; },
  };
}

function makeHand(players = [{ id: "Bot1", stack: 1000 }, { id: "Bot2", stack: 1000 }, { id: "Bot3", stack: 1000 }]) {
  const deck = fixedDeck([
    c(14, "s"), c(13, "s"), c(2, "h"), c(3, "h"), c(9, "c"), c(9, "d"),
    c(4, "c"), c(4, "d"), c(5, "c"), c(6, "c"), c(7, "c"), c(8, "c"), c(10, "c"),
  ]);
  return new Hand({ players, minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: 0, deck });
}

function fakeTableGame(overrides = {}) {
  return { startingStack: 1000, currentHandActions: [], ...overrides };
}

test("decidePowerUpUse never throws and always returns a { use, target? } shape, across every catalog entry", () => {
  const hand = makeHand();
  const tg = fakeTableGame();
  for (const p of POWER_UPS_CATALOG) {
    const decision = decidePowerUpUse("Bot1", hand, p.key, tg);
    assert.equal(typeof decision, "object");
    assert.equal(typeof decision.use, "boolean");
    if (decision.target !== undefined) assert.equal(typeof decision.target, "string");
  }
});

test("decidePowerUpUse returns { use: false } for an unrecognized power-up key rather than throwing", () => {
  const hand = makeHand();
  const decision = decidePowerUpUse("Bot1", hand, "not-a-real-power-up", fakeTableGame());
  assert.deepEqual(decision, { use: false });
});

test("decidePowerUpUse never crashes when it's not actually the given player's turn (a stale/mismatched call)", () => {
  const hand = makeHand();
  // "Bot2" isn't the acting player (heads-up/3-way preflop, dealer acts
  // first) - legalActions("Bot2") still resolves to a real (non-acting)
  // player's legal shape though, since legalActions doesn't itself check
  // turn ownership - this is really just confirming no exception either way.
  assert.doesNotThrow(() => decidePowerUpUse("Bot2", hand, "xrayVision", fakeTableGame()));
});

test("a targeted power-up (xrayVision/freezeSilence) never targets the bot itself", () => {
  const hand = makeHand();
  const tg = fakeTableGame();
  for (let i = 0; i < 40; i++) {
    const decision = decidePowerUpUse("Bot1", hand, "xrayVision", tg);
    if (decision.use) assert.notEqual(decision.target, "Bot1");
  }
});

test("a targeted power-up only ever targets a still-live (non-folded) opponent", () => {
  const hand = makeHand();
  hand.folded.add("Bot2");
  const tg = fakeTableGame();
  for (let i = 0; i < 40; i++) {
    const decision = decidePowerUpUse("Bot1", hand, "freezeSilence", tg);
    if (decision.use) assert.notEqual(decision.target, "Bot2");
  }
});

// ===== pickOpponentTarget =====

test("pickOpponentTarget returns null when no live opponents remain", () => {
  const hand = makeHand([{ id: "Solo", stack: 1000 }]);
  assert.equal(pickOpponentTarget("Solo", hand, fakeTableGame()), null);
});

test("pickOpponentTarget prefers the most recently aggressive live opponent when one exists", () => {
  const hand = makeHand();
  const tg = fakeTableGame({
    currentHandActions: [
      { actor: "Bot2", action: "call" },
      { actor: "Bot3", action: "raise" },
    ],
  });
  assert.equal(pickOpponentTarget("Bot1", hand, tg), "Bot3");
});

test("pickOpponentTarget falls back to a random live opponent when nobody's shown aggression yet", () => {
  const hand = makeHand();
  const tg = fakeTableGame();
  const target = pickOpponentTarget("Bot1", hand, tg);
  assert.ok(["Bot2", "Bot3"].includes(target));
});
