import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";

// The highest-risk surface in the whole private-rooms feature: a bug here
// leaks one real person's hole cards to another real person, before
// showdown. Every assertion in this file is checking exactly that boundary.

function makeRoomGame(playerIds, config = {}) {
  const game = new TableGame({ roomMode: true, startingStack: 1000, smallBlind: 5, bigBlind: 10, ...config });
  for (const id of playerIds) game.addPlayer({ id });
  game.gameStarted = true;
  return game;
}

function isMasked(playerState) {
  return playerState.holeCards.every((c) => c.rank === 0 && c.suit === "");
}

function playCheckdownToShowdown(game) {
  let guard = 0;
  while (!game.hand.complete && guard++ < 100) {
    const actingId = game.hand.actingPlayerId();
    const legal = game.hand.legalActions(actingId);
    game.applyPlayerAction(actingId, legal.check ? "check" : "call");
  }
}

test("roomMode: TableGame starts with zero seated players until addPlayer is called", () => {
  const game = new TableGame({ roomMode: true });
  assert.deepEqual(game.players, []);
  assert.ok(game.hasOpenSeat());
});

test("addPlayer seats a real human, assigns a seat, and is idempotent for the same id", () => {
  const game = new TableGame({ roomMode: true, startingStack: 1000 });
  const p1 = game.addPlayer({ id: "Alice" });
  assert.equal(p1.id, "Alice");
  assert.equal(p1.type, "human");
  assert.equal(p1.seat, 0);

  const p2 = game.addPlayer({ id: "Bob" });
  assert.equal(p2.seat, 1);

  const p1Again = game.addPlayer({ id: "Alice" });
  assert.equal(game.players.length, 2, "re-adding the same id should not create a duplicate seat");
  assert.equal(p1Again.id, "Alice");
});

test("addPlayer refuses to seat anyone once the table is full (9 max)", () => {
  const game = new TableGame({ roomMode: true });
  for (let i = 0; i < 9; i++) game.addPlayer({ id: `P${i}` });
  assert.equal(game.hasOpenSeat(), false);
  assert.equal(game.addPlayer({ id: "P9" }), null);
  assert.equal(game.players.length, 9);
});

test("getStateFor: only the viewer's own hole cards are real pre-showdown - every other player's, including other real humans, stay masked", () => {
  const game = makeRoomGame(["Alice", "Bob", "Carol"]);
  game.startNewHand();
  assert.equal(game.hand.complete, false);

  for (const viewerId of ["Alice", "Bob", "Carol"]) {
    const state = game.getStateFor(viewerId);
    for (const p of state.players) {
      if (p.id === viewerId) {
        assert.equal(isMasked(p), false, `${viewerId} should see their own real hole cards`);
      } else {
        assert.equal(isMasked(p), true, `${viewerId} should NOT see ${p.id}'s real hole cards pre-showdown`);
      }
    }
  }
});

test("getStateFor: a viewerId that isn't seated at all (a spectator) sees every hole card masked pre-showdown", () => {
  const game = makeRoomGame(["Alice", "Bob"]);
  game.startNewHand();
  const state = game.getStateFor("SomeRandomSpectator");
  for (const p of state.players) {
    assert.equal(isMasked(p), true, `spectator should not see ${p.id}'s real hole cards`);
  }
  assert.equal(state.legalActions, null, "a spectator can never have legal actions");
});

test("getStateFor: legalActions is populated only for whoever is actually the acting player - null for everyone else, including spectators", () => {
  const game = makeRoomGame(["Alice", "Bob", "Carol"]);
  game.startNewHand();
  const actingId = game.hand.actingPlayerId();

  for (const viewerId of ["Alice", "Bob", "Carol", "SomeSpectator"]) {
    const state = game.getStateFor(viewerId);
    if (viewerId === actingId) {
      assert.ok(state.legalActions, `${viewerId} is acting and should have legalActions`);
    } else {
      assert.equal(state.legalActions, null, `${viewerId} is not acting and should have null legalActions`);
    }
  }
});

test("getStateFor: a folded player's hole cards stay masked to still-live players until the whole hand completes, not just until they fold", () => {
  const game = makeRoomGame(["Alice", "Bob", "Carol"]);
  game.startNewHand();

  let guard = 0;
  while (!game.hand.folded.has("Alice") && !game.hand.complete && guard++ < 50) {
    const actingId = game.hand.actingPlayerId();
    if (actingId === "Alice") {
      game.applyPlayerAction("Alice", "fold");
    } else {
      const legal = game.hand.legalActions(actingId);
      game.applyPlayerAction(actingId, legal.check ? "check" : "call");
    }
  }
  assert.ok(game.hand.folded.has("Alice"), "Alice should have folded");
  assert.equal(game.hand.complete, false, "hand should still be in progress - Bob/Carol are still live");

  const bobView = game.getStateFor("Bob");
  const aliceFromBobView = bobView.players.find((p) => p.id === "Alice");
  assert.equal(isMasked(aliceFromBobView), true, "Alice's cards should stay masked to Bob even after she folds, until the hand fully completes");
});

test("getStateFor: once the hand completes, every viewer (including a spectator) sees every hole card revealed", () => {
  const game = makeRoomGame(["Alice", "Bob"]);
  game.startNewHand();
  playCheckdownToShowdown(game);
  assert.equal(game.hand.complete, true);

  for (const viewerId of ["Alice", "Bob", "SomeSpectator"]) {
    const state = game.getStateFor(viewerId);
    for (const p of state.players) {
      assert.equal(isMasked(p), false, `${viewerId} should see ${p.id}'s real hole cards once the hand is complete`);
    }
  }
});

test("getState() (no-arg) is unchanged for solo games - still resolves the single human and behaves exactly as before", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.startNewHand();
  if (game.botTimeout) { clearTimeout(game.botTimeout); game.botTimeout = null; }

  const soloState = game.getState();
  const explicitState = game.getStateFor("You");
  assert.deepEqual(soloState, explicitState);
  assert.equal(soloState.viewerId, "You");
});
