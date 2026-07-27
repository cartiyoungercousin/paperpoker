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
  // Deal order: alice's 2 hole cards, bob's 2 hole cards, burn, flop (3), burn, turn (1), burn, river (1)
  const deck = fixedDeck([
    c(14, "h"), c(13, "h"), // alice: Ah Kh
    c(2, "c"), c(3, "d"), // bob: 2c 3d
    c(1, "s"), // burn
    c(9, "s"), c(7, "d"), c(4, "c"), // flop
    c(1, "d"), // burn
    c(10, "h"), // turn
    c(1, "c"), // burn
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

  // Preflop: alice (SB/button) acts first heads-up, both just get to
  // showdown with checks/calls.
  assert.equal(hand.actingPlayerId(), "alice");
  hand.applyAction("alice", "call"); // completes the blind to match bob's bb
  hand.applyAction("bob", "check"); // bb option closes preflop

  // Postflop, heads-up flips first-to-act to the big blind (bob) - the
  // button (alice) gets the positional advantage of acting last on every
  // street after preflop, same as real hold'em rules.
  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.actingPlayerId(), "bob");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");

  assert.equal(hand.currentStreetName(), "turn");
  assert.equal(hand.actingPlayerId(), "bob");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");

  assert.equal(hand.currentStreetName(), "river");
  assert.equal(hand.actingPlayerId(), "bob");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");

  assert.ok(hand.complete);
  assert.equal(hand.board.length, 5);

  // alice has Ace-high, bob has nothing better - alice should win the
  // whole 4-chip pot (1 sb + 1 call from alice, 2 bb from bob)
  assert.equal(hand.result.payouts.get("alice"), 4);
  assert.equal(hand.result.payouts.get("bob"), 0);
});

// Regression test for a real rules bug: heads-up postflop first-to-act was
// previously hardcoded to the small blind/button seat on every street,
// which is only correct preflop. From the flop onward heads-up, the big
// blind acts first and the button acts last (the button's positional
// advantage) - this dedicated test exists so a future refactor can't
// silently reintroduce the preflop-seat assumption postflop.
test("heads-up: the big blind (not the button) acts first on every postflop street", () => {
  const deck = fixedDeck([
    c(7, "h"), c(2, "h"), // alice (dealer/SB/button)
    c(8, "c"), c(3, "d"), // bob (BB)
    c(1, "s"), c(9, "s"), c(10, "d"), c(4, "c"), // burn, flop
    c(1, "d"), c(11, "h"), // burn, turn
    c(1, "c"), c(12, "s"), // burn, river
  ]);

  const hand = new Hand({
    players: [
      { id: "alice", stack: 100 },
      { id: "bob", stack: 100 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0, // alice is dealer/SB/button, bob is BB
    deck,
  });

  hand.applyAction("alice", "call");
  hand.applyAction("bob", "check");

  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.actingPlayerId(), "bob", "BB should act first on the flop, heads-up");
  hand.applyAction("bob", "check");
  assert.equal(hand.actingPlayerId(), "alice", "button acts last on the flop, heads-up");
  hand.applyAction("alice", "check");

  assert.equal(hand.currentStreetName(), "turn");
  assert.equal(hand.actingPlayerId(), "bob", "BB should act first on the turn, heads-up");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");

  assert.equal(hand.currentStreetName(), "river");
  assert.equal(hand.actingPlayerId(), "bob", "BB should act first on the river, heads-up");
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
    c(1, "s"), // burn
    c(9, "s"), c(8, "s"), c(7, "s"), // flop
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

test("allInSnapshot captures the (empty) board and hole cards at a preflop all-in", () => {
  const deck = fixedDeck([
    c(14, "h"), c(14, "s"), // alice: Ah As
    c(2, "c"), c(3, "d"), // bob: 2c 3d
    c(1, "s"), // burn
    c(9, "s"), c(7, "d"), c(4, "c"), // flop
    c(1, "d"), // burn
    c(10, "h"), // turn
    c(1, "c"), // burn
    c(6, "s"), // river
  ]);

  const hand = new Hand({
    players: [
      { id: "alice", stack: 50 },
      { id: "bob", stack: 50 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0, // heads-up: alice is SB/dealer, acts first
    deck,
  });

  assert.equal(hand.allInSnapshot, null);
  hand.applyAction("alice", "raise", 50); // shoves the rest of her stack
  hand.applyAction("bob", "call"); // calls all-in - both stacks now 0

  assert.ok(hand.allInSnapshot, "everyone live in the hand is all-in preflop");
  assert.deepEqual(hand.allInSnapshot.boardAtAllIn, []);
  assert.equal(hand.allInSnapshot.participants.length, 2);
  const aliceEntry = hand.allInSnapshot.participants.find((p) => p.id === "alice");
  assert.deepEqual(aliceEntry.holeCards, [c(14, "h"), c(14, "s")]);

  assert.ok(hand.complete);
  assert.equal(hand.board.length, 5, "the rest of the board should still get dealt out");
});

test("allInSnapshot captures the 3-card board at a flop-stage all-in", () => {
  const deck = fixedDeck([
    c(14, "h"), c(14, "s"), // alice
    c(2, "c"), c(3, "d"), // bob
    c(1, "s"), // burn
    c(9, "s"), c(7, "d"), c(4, "c"), // flop
    c(1, "d"), // burn
    c(10, "h"), // turn
    c(1, "c"), // burn
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
    dealerIndex: 0,
    deck,
  });

  hand.applyAction("alice", "call"); // completes SB to match BB
  hand.applyAction("bob", "check"); // BB option closes preflop

  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.allInSnapshot, null);

  // Heads-up, the big blind (bob) acts first postflop.
  hand.applyAction("bob", "bet", 98); // shoves the rest of his stack
  hand.applyAction("alice", "call"); // calls all-in

  assert.ok(hand.allInSnapshot);
  assert.deepEqual(hand.allInSnapshot.boardAtAllIn, [c(9, "s"), c(7, "d"), c(4, "c")]);
});

test("allInSnapshot stays null for a hand where no one goes all-in", () => {
  const deck = fixedDeck([
    c(14, "h"), c(13, "h"),
    c(2, "c"), c(3, "d"),
    c(1, "s"),
    c(9, "s"), c(7, "d"), c(4, "c"),
    c(1, "d"),
    c(10, "h"),
    c(1, "c"),
    c(6, "s"),
  ]);
  const hand = new Hand({
    players: [{ id: "alice", stack: 100 }, { id: "bob", stack: 100 }],
    minRaise: 2, smallBlind: 1, bigBlind: 2, dealerIndex: 0, deck,
  });
  hand.applyAction("alice", "call");
  hand.applyAction("bob", "check");
  // Heads-up, bob (BB) acts first on every postflop street.
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");
  hand.applyAction("bob", "check");
  hand.applyAction("alice", "check");

  assert.ok(hand.complete);
  assert.equal(hand.allInSnapshot, null);
});

test("allInSnapshot stays null when the hand ends by everyone folding", () => {
  const deck = fixedDeck([c(2, "h"), c(3, "h"), c(9, "c"), c(9, "d")]);
  const hand = new Hand({
    players: [{ id: "alice", stack: 100 }, { id: "bob", stack: 100 }],
    minRaise: 2, smallBlind: 1, bigBlind: 2, dealerIndex: 0, deck,
  });
  hand.applyAction("alice", "raise", 10);
  hand.applyAction("bob", "fold");

  assert.ok(hand.complete);
  assert.equal(hand.allInSnapshot, null);
});

test("a 3-handed street correctly skips a player who is already all-in when picking who acts next (regression: used to stall the hand forever)", () => {
  // Bob shoves preflop and ends up all-in in exactly the seat ("small
  // blind") that postflop action starts from. Picking who acts next used to
  // only check fold status, so it would hand bob the turn even though he's
  // all-in and has no legal action left - nothing else ever advanced the
  // hand from there, a real stuck-hand bug this test guards against.
  const deck = fixedDeck([
    c(2, "h"), c(3, "h"), // alice
    c(4, "c"), c(5, "d"), // bob
    c(9, "s"), c(9, "d"), // carol
    c(1, "s"), // burn
    c(6, "s"), c(7, "d"), c(8, "c"), // flop
    c(1, "d"), // burn
    c(10, "h"), // turn
    c(1, "c"), // burn
    c(11, "s"), // river
  ]);

  const hand = new Hand({
    players: [
      { id: "alice", stack: 100 },
      { id: "bob", stack: 20 },
      { id: "carol", stack: 100 },
    ],
    minRaise: 10,
    smallBlind: 5,
    bigBlind: 10,
    dealerIndex: 0, // alice is the button; bob posts SB, carol posts BB
    deck,
  });

  assert.equal(hand.sbId, "bob");
  assert.equal(hand.bbId, "carol");
  assert.equal(hand.actingPlayerId(), "alice", "the button acts first preflop 3-handed");

  hand.applyAction("alice", "fold");
  assert.equal(hand.actingPlayerId(), "bob");
  hand.applyAction("bob", "raise", 20); // raise TO 20 = bob's whole 20-chip stack
  assert.equal(hand.actingPlayerId(), "carol");
  hand.applyAction("carol", "call");

  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.actingPlayerId(), "carol", "should skip the all-in bob and let carol act");
  hand.applyAction("carol", "check");

  assert.equal(hand.currentStreetName(), "turn");
  assert.equal(hand.actingPlayerId(), "carol");
  hand.applyAction("carol", "check");

  assert.equal(hand.currentStreetName(), "river");
  assert.equal(hand.actingPlayerId(), "carol");
  hand.applyAction("carol", "check");

  assert.ok(hand.complete, "the hand should reach showdown instead of stalling on the all-in player");
  assert.ok(hand.result);
});