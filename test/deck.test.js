import { test } from "node:test";
import assert from "node:assert/strict";
import { Deck } from "../src/deck.js";

test("peek(n) returns the next n cards without removing them from the deck", () => {
  const deck = new Deck().shuffle();
  const before = deck.remaining();
  const peeked = deck.peek(3);
  assert.equal(peeked.length, 3);
  assert.equal(deck.remaining(), before, "peek should not change the deck's size");
});

test("peek(n) returns exactly what a subsequent draw(n) would return", () => {
  const deck = new Deck().shuffle();
  const peeked = deck.peek(2);
  const drawn = deck.draw(2);
  assert.deepEqual(peeked, drawn);
});

test("peek() defaults to a single card", () => {
  const deck = new Deck().shuffle();
  const peeked = deck.peek();
  assert.equal(peeked.length, 1);
});

test("peek(n) throws rather than under-return when asked for more cards than remain", () => {
  const deck = new Deck().shuffle();
  deck.draw(50); // leaves 2 cards
  assert.throws(() => deck.peek(3));
});

test("peek() can be called repeatedly without disturbing draw order", () => {
  const deck = new Deck().shuffle();
  const first = deck.peek(1);
  const second = deck.peek(1);
  assert.deepEqual(first, second);
  assert.deepEqual(deck.draw(1), first);
});
