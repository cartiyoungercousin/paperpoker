import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../src/hand.js";

function c(rank, suit) {
  return { rank, suit };
}

// A fake "deck" that deals cards in a fixed, known order instead of
// randomly - this is what makes the hand's outcome predictable for tests.
function fixedDeck(cardsInDealOrder) {
  return {
    cards: [...cardsInDealOrder],
    draw(n) {
      return this.cards.splice(0, n);
    },
  };
}

test("a full heads-up hand plays out correctly to showdown", () => {
  // Deal order: alice's 2 hole cards, bob's 2 hole cards, flop (3), turn (1), river (1)
  const deck = fixedDeck([
    c(14, "h"), c(13, "h"), // alice: Ah Kh
    c(2, "c"), c(3, "d"), // bob: 2c 3d
    c(9, "s"), c(7, "d"), c(4, "c"), // flop
    c(10, "h"), // turn
    c(6, "s"), // river
  ]);

  const hand = new Hand({
    players: [
      { id: "alice", stack: 100 },
      { id: "bob", stack: 100 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0, // heads-up: alice is dealer/small blind, bob is big blind
    deck,
  });

  // Preflop: alice (SB) acts first, both just get to showdown with checks/calls
  assert.equal(hand.actingPlayerId(), "alice");
  hand.applyAction("alice", "call"); // completes the blind to match bob's bb
  hand.applyAction("bob", "check"); // bb option closes preflop

  assert.equal(hand.currentStreetName(), "flop");
  hand.applyAction("alice", "check");
  hand.applyAction("bob", "check");

  assert.equal(hand.currentStreetName(), "turn");
  hand.applyAction("alice", "check");
  hand.applyAction("bob", "check");

  assert.equal(hand.currentStreetName(), "river");
  hand.applyAction("alice", "check");
  hand.applyAction("bob", "check");

  assert.ok(hand.complete);
  assert.equal(hand.board.length, 5);

  // alice has Ace-high, bob has nothing better - alice should win the
  // whole 4-chip pot (1 sb + 1 call from alice, 2 bb from bob)
  assert.equal(hand.result.payouts.get("alice"), 4);
  assert.equal(hand.result.payouts.get("bob"), 0);
});

test("folding preflop ends the hand immediately without dealing a board", () => {
  const deck = fixedDeck([c(2, "h"), c(3, "h"), c(9, "c"), c(9, "d")]);

  const hand = new Hand({
    players: [
      { id: "alice", stack: 100 },
      { id: "bob", stack: 100 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0,
    deck,
  });

  assert.equal(hand.actingPlayerId(), "alice");
  hand.applyAction("alice", "raise", 10);
  hand.applyAction("bob", "fold");

  assert.ok(hand.complete);
  assert.equal(hand.board.length, 0, "no board should be dealt if the hand ends on a fold");
  assert.equal(hand.result.payouts.get("alice"), 12); // alice's 10 + bob's 2bb
  assert.equal(hand.result.payouts.get("bob"), 0);
});

test("3-handed: correct blind assignment and preflop action order", () => {
  const deck = fixedDeck([
    c(2, "h"), c(3, "h"), // a
    c(4, "c"), c(5, "c"), // b
    c(6, "d"), c(7, "d"), // c
  ]);

  const hand = new Hand({
    players: [
      { id: "a", stack: 100 },
      { id: "b", stack: 100 },
      { id: "c", stack: 100 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0, // a is dealer/button
    deck,
  });

  // With 3 players: b posts SB, c posts BB, a (the button) acts first preflop
  assert.equal(hand.actingPlayerId(), "a");

  hand.applyAction("a", "fold");
  assert.equal(hand.actingPlayerId(), "b");
  hand.applyAction("b", "call"); // completes SB to match the BB
  hand.applyAction("c", "check"); // BB option closes preflop

  assert.equal(hand.currentStreetName(), "flop");
});