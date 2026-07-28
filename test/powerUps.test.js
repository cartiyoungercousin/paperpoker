import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../src/hand.js";
import { POWER_UPS_CATALOG, POWER_UP_HANDLERS, findPowerUp } from "../src/powerUps.js";

function c(rank, suit) { return { rank, suit }; }

// Same technique test/hand.test.js and test/hand-analysis.test.js already
// use for deterministic card control - a plain object matching the real
// Deck's interface (draw/peek/remaining), backed by a fixed array instead
// of a shuffled 52-card deck.
function fixedDeck(cardsInDealOrder) {
  return {
    cards: [...cardsInDealOrder],
    draw(n = 1) {
      if (n > this.cards.length) throw new Error("Not enough cards left in the deck");
      return this.cards.splice(0, n);
    },
    peek(n = 1) {
      if (n > this.cards.length) throw new Error("Not enough cards left in the deck");
      return this.cards.slice(0, n);
    },
    remaining() { return this.cards.length; },
  };
}

// Two-player hand, "A" and "B", with a generous fixed deck so every
// handler under test has cards left to draw/peek from regardless of what
// the deal itself already consumed.
function makeHand(extraCards = []) {
  const deck = fixedDeck([
    c(14, "s"), c(13, "s"), // A's hole cards
    c(2, "h"), c(3, "h"),   // B's hole cards
    ...extraCards.length ? extraCards : [c(9, "c"), c(9, "d"), c(9, "s"), c(9, "h"), c(4, "c"), c(4, "d")],
  ]);
  return new Hand({
    players: [{ id: "A", stack: 1000 }, { id: "B", stack: 1000 }],
    minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: 0, deck,
  });
}

// ===== Catalog =====

test("POWER_UPS_CATALOG has exactly the 10 shipped entries, each fully described", () => {
  assert.equal(POWER_UPS_CATALOG.length, 10);
  for (const p of POWER_UPS_CATALOG) {
    assert.equal(typeof p.key, "string");
    assert.ok(p.key.length > 0);
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.icon, "string");
    assert.equal(typeof p.category, "string");
    assert.equal(typeof p.description, "string");
    assert.ok(p.description.length > 0);
    assert.equal(typeof p.needsTarget, "boolean");
    assert.equal(typeof POWER_UP_HANDLERS[p.key], "function", `${p.key} should have a matching handler`);
  }
});

test("POWER_UPS_CATALOG has no duplicate keys", () => {
  const keys = POWER_UPS_CATALOG.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("findPowerUp resolves a known key and returns null for an unknown one", () => {
  assert.equal(findPowerUp("xrayVision").name, "X-Ray Vision");
  assert.equal(findPowerUp("not-a-real-key"), null);
});

// ===== X-Ray Vision =====

test("xrayVision reveals one of the target's hole cards as private info, without mutating anything", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.xrayVision(null, hand, "A", "B");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.privateInfo, { type: "xrayVision", target: "B", card: c(2, "h") });
  // Nothing about the actual hand state should have changed.
  assert.deepEqual(hand.holeCards.get("B"), [c(2, "h"), c(3, "h")]);
});

test("xrayVision refuses to target yourself, an unknown player, or someone already folded", () => {
  const hand = makeHand();
  assert.match(POWER_UP_HANDLERS.xrayVision(null, hand, "A", "A").error, /opponent/i);
  assert.match(POWER_UP_HANDLERS.xrayVision(null, hand, "A", "Ghost").error, /unknown/i);
  hand.folded.add("B");
  assert.match(POWER_UP_HANDLERS.xrayVision(null, hand, "A", "B").error, /folded/i);
});

// ===== Mind Reader =====

test("mindReader reveals BOTH of the target's hole cards as private info, without mutating anything", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.mindReader(null, hand, "A", "B");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.privateInfo, { type: "mindReader", target: "B", cards: [c(2, "h"), c(3, "h")] });
  assert.deepEqual(hand.holeCards.get("B"), [c(2, "h"), c(3, "h")]);
});

test("mindReader refuses to target yourself, an unknown player, or someone already folded", () => {
  const hand = makeHand();
  assert.match(POWER_UP_HANDLERS.mindReader(null, hand, "A", "A").error, /opponent/i);
  assert.match(POWER_UP_HANDLERS.mindReader(null, hand, "A", "Ghost").error, /unknown/i);
  hand.folded.add("B");
  assert.match(POWER_UP_HANDLERS.mindReader(null, hand, "A", "B").error, /folded/i);
});

// ===== Deck Whisperer =====

test("deckWhisperer reveals the next stub card as private info without removing it from the deck", () => {
  const hand = makeHand([c(9, "c"), c(9, "d")]);
  const before = hand.deck.remaining();
  const result = POWER_UP_HANDLERS.deckWhisperer(null, hand);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.privateInfo, { type: "deckWhisperer", card: c(9, "c") });
  assert.equal(hand.deck.remaining(), before, "peeking should not consume the card");
  // The next real draw should still be that same card.
  assert.deepEqual(hand.deck.draw(1), [c(9, "c")]);
});

// ===== Sleight of Hand =====

test("sleightOfHand swaps the activator's first hole card for a freshly-drawn one, leaving the second untouched", () => {
  const hand = makeHand([c(9, "c"), c(9, "d")]);
  const before = hand.deck.remaining();
  const result = POWER_UP_HANDLERS.sleightOfHand(null, hand, "A");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.privateInfo, { type: "sleightOfHand", oldCard: c(14, "s"), newCard: c(9, "c") });
  assert.deepEqual(hand.holeCards.get("A"), [c(9, "c"), c(13, "s")]);
  assert.equal(hand.deck.remaining(), before - 1, "drawing the replacement should consume a real card from the deck");
});

test("sleightOfHand only ever touches the activator's own hand, never an opponent's", () => {
  const hand = makeHand([c(9, "c")]);
  POWER_UP_HANDLERS.sleightOfHand(null, hand, "A");
  assert.deepEqual(hand.holeCards.get("B"), [c(2, "h"), c(3, "h")]);
});

// ===== Mulligan =====

test("mulligan discards BOTH of the activator's hole cards and draws two fresh ones", () => {
  const hand = makeHand([c(9, "c"), c(9, "d")]);
  const before = hand.deck.remaining();
  const result = POWER_UP_HANDLERS.mulligan(null, hand, "A");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.privateInfo, { type: "mulligan", oldCards: [c(14, "s"), c(13, "s")], newCards: [c(9, "c"), c(9, "d")] });
  assert.deepEqual(hand.holeCards.get("A"), [c(9, "c"), c(9, "d")]);
  assert.equal(hand.deck.remaining(), before - 2, "drawing 2 replacements should consume 2 real cards from the deck");
});

test("mulligan only ever touches the activator's own hand, never an opponent's", () => {
  const hand = makeHand([c(9, "c"), c(9, "d")]);
  POWER_UP_HANDLERS.mulligan(null, hand, "A");
  assert.deepEqual(hand.holeCards.get("B"), [c(2, "h"), c(3, "h")]);
});

// ===== Freaky Friday =====

test("freakyFriday swaps the activator's entire hand with the target's - a straight trade, no deck draw", () => {
  const hand = makeHand();
  const before = hand.deck.remaining();
  const result = POWER_UP_HANDLERS.freakyFriday(null, hand, "A", "B");
  assert.deepEqual(result, {});
  assert.deepEqual(hand.holeCards.get("A"), [c(2, "h"), c(3, "h")], "A now has B's original cards");
  assert.deepEqual(hand.holeCards.get("B"), [c(14, "s"), c(13, "s")], "B now has A's original cards");
  assert.equal(hand.deck.remaining(), before, "a straight trade never touches the deck");
});

test("freakyFriday refuses to target yourself, an unknown player, or someone already folded", () => {
  const hand = makeHand();
  assert.match(POWER_UP_HANDLERS.freakyFriday(null, hand, "A", "A").error, /opponent/i);
  assert.match(POWER_UP_HANDLERS.freakyFriday(null, hand, "A", "Ghost").error, /unknown/i);
  hand.folded.add("B");
  assert.match(POWER_UP_HANDLERS.freakyFriday(null, hand, "A", "B").error, /folded/i);
});

// ===== Insurance / Bounty Hunter (flag-only at activation time) =====

test("insurance just flags the activator for a payout-time check - no immediate state change", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.insurance(null, hand, "A");
  assert.deepEqual(result, {});
  assert.ok(hand._rumbleInsurancePlayers.has("A"));
  assert.deepEqual(hand.holeCards.get("A"), [c(14, "s"), c(13, "s")], "hand itself is untouched");
});

test("bountyHunter just flags the activator for a payout-time check - no immediate state change", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.bountyHunter(null, hand, "A");
  assert.deepEqual(result, {});
  assert.ok(hand._rumbleBountyPlayers.has("A"));
});

test("insurance and bountyHunter track different players independently", () => {
  const hand = makeHand();
  POWER_UP_HANDLERS.insurance(null, hand, "A");
  POWER_UP_HANDLERS.bountyHunter(null, hand, "B");
  assert.ok(hand._rumbleInsurancePlayers.has("A"));
  assert.equal(hand._rumbleInsurancePlayers.has("B"), false);
  assert.ok(hand._rumbleBountyPlayers.has("B"));
  assert.equal(hand._rumbleBountyPlayers.has("A"), false);
});

// ===== Freeze / Silence =====

test("freezeSilence sets frozenPlayerId on the CURRENT betting round", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B");
  assert.deepEqual(result, {});
  assert.equal(hand.currentRound.frozenPlayerId, "B");
});

test("freezeSilence refuses to target yourself, an unknown player, or someone already folded", () => {
  const hand = makeHand();
  assert.match(POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "A").error, /opponent/i);
  assert.match(POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "Ghost").error, /unknown/i);
  hand.folded.add("B");
  assert.match(POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B").error, /folded/i);
});

test("freezeSilence refuses to target a player who's already all-in (nothing left to freeze)", () => {
  const hand = makeHand();
  hand.currentRound.getPlayer("B").allIn = true;
  assert.match(POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B").error, /no more decisions/i);
});

test("a frozen player's legalActions masks out raise and fold, forcing check/call only", () => {
  const hand = makeHand();
  POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B");
  const legal = hand.legalActions("B");
  assert.equal(legal.raise, false);
  assert.equal(legal.fold, false);
  assert.equal(legal.bet, false);
  // check/call availability is unaffected by freeze itself - whatever the
  // normal pot-odds situation already allows stays allowed.
});

test("a frozen player who attempts to fold anyway is rejected server-side, not just hidden client-side", () => {
  const hand = makeHand();
  POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B");
  // "A" acts first (dealer, heads-up) - advance to B's turn, then try to
  // fold on B's behalf despite the freeze.
  hand.applyAction("A", "call");
  assert.equal(hand.actingPlayerId(), "B");
  assert.throws(() => hand.applyAction("B", "fold"), /cannot fold/i);
});

test("freeze naturally expires once the street changes (a fresh BettingRound has no frozenPlayerId)", () => {
  const hand = makeHand();
  POWER_UP_HANDLERS.freezeSilence(null, hand, "A", "B");
  assert.equal(hand.currentRound.frozenPlayerId, "B");
  hand.applyAction("A", "call");
  hand.applyAction("B", "check"); // closes preflop, deals the flop
  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.currentRound.frozenPlayerId, null, "the new street's BettingRound should not inherit the freeze");
});

// ===== Deadman's Fold (flag-only at activation time, same shape as Insurance/Bounty Hunter) =====

test("deadmansFold just flags the activator for a fold-time check - no immediate state change", () => {
  const hand = makeHand();
  const result = POWER_UP_HANDLERS.deadmansFold(null, hand, "A");
  assert.deepEqual(result, {});
  assert.ok(hand._rumbleDeadmansFoldPlayers.has("A"));
  assert.deepEqual(hand.holeCards.get("A"), [c(14, "s"), c(13, "s")], "hand itself is untouched");
});

test("deadmansFold, insurance, and bountyHunter each track their own players independently", () => {
  const hand = makeHand();
  POWER_UP_HANDLERS.deadmansFold(null, hand, "A");
  POWER_UP_HANDLERS.insurance(null, hand, "B");
  assert.ok(hand._rumbleDeadmansFoldPlayers.has("A"));
  assert.equal(hand._rumbleDeadmansFoldPlayers.has("B"), false);
  assert.equal(hand._rumbleInsurancePlayers.has("A"), false);
});
