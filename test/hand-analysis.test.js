import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame, buildHandAnalysis } from "../server.js";

function cancelPendingBotTimer(game) {
  if (game.botTimeout) {
    clearTimeout(game.botTimeout);
    game.botTimeout = null;
  }
}

function botId(game) {
  return game.players.find((p) => p.type === "bot").id;
}

// Mirrors what checkBotTurn()'s real setTimeout callback does when a bot
// acts, minus the timer and bot-AI decision - so these tests stay fast and
// deterministic while still exercising the same action/street recording
// path (_recordAction) that production bot turns go through. Bypassing it
// (calling hand.applyAction directly) would silently skip streetSnapshots/
// currentHandActions tracking, which is exactly what buildHandAnalysis reads.
function applyOpponentAction(game, id, action, amount) {
  const prevStreet = game.hand.currentStreetName();
  game.hand.applyAction(id, action, amount);
  game._recordAction(id, action, amount, prevStreet);
}

test("buildHandAnalysis returns null when there's no completed hand", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(buildHandAnalysis(game), null); // no hand started yet

  game.gameStarted = true;
  game.startNewHand();
  assert.equal(buildHandAnalysis(game), null); // hand in progress, not complete
});

test("buildHandAnalysis: a full check-down to showdown produces one snapshot per street with monotonically growing boards and correctly street-tagged actions", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" is SB, acts first every street
  game.startNewHand();
  const bot = botId(game);

  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);
  applyOpponentAction(game, bot, "check");

  for (let street = 0; street < 3 && !game.hand.complete; street++) {
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) applyOpponentAction(game, bot, "check");
  }
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  const analysis = buildHandAnalysis(game);
  assert.ok(analysis);
  assert.equal(analysis.streetSnapshots.length, 4);
  assert.deepEqual(analysis.streetSnapshots.map((s) => s.street), ["preflop", "flop", "turn", "river"]);

  let prevLen = -1;
  for (const snap of analysis.streetSnapshots) {
    assert.ok(snap.board.length > prevLen, "board should grow monotonically street to street");
    prevLen = snap.board.length;
    assert.deepEqual(snap.board, game.hand.board.slice(0, snap.board.length));
    for (const action of snap.actions) {
      assert.equal(action.street, snap.street, "every action attached to a snapshot should be tagged with that street");
    }
    // Nobody folded, so equity should be computed (a number in [0,1]) at every street
    assert.equal(typeof snap.equityAtStreet, "number");
    assert.ok(snap.equityAtStreet >= 0 && snap.equityAtStreet <= 1);
  }

  // Preflop's action list should contain both the call and the check
  const preflopActions = analysis.streetSnapshots[0].actions;
  assert.equal(preflopActions.length, 2);
  assert.equal(preflopActions[0].actor, "You");
  assert.equal(preflopActions[0].action, "call");
});

test("buildHandAnalysis: equity stops being computed for streets after You folded", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();
  const bot = botId(game);

  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);
  applyOpponentAction(game, bot, "check"); // -> flop

  assert.equal(game.hand.currentStreetName(), "flop");
  assert.ok(game.applyPlayerAction("You", "fold")); // auto-completes the hand (heads-up)

  const analysis = buildHandAnalysis(game);
  assert.equal(analysis.streetSnapshots.length, 2, "only preflop and flop snapshots should exist");
  assert.equal(analysis.streetSnapshots[0].street, "preflop");
  assert.equal(typeof analysis.streetSnapshots[0].equityAtStreet, "number", "equity entering preflop should be known");
  assert.equal(analysis.streetSnapshots[1].street, "flop");
  assert.equal(typeof analysis.streetSnapshots[1].equityAtStreet, "number", "equity entering the flop (before folding on it) should be known");
});

test("buildHandAnalysis: uses exact equity for streets at/after an all-in You were part of", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 50, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();
  const bot = botId(game);

  assert.ok(game.applyPlayerAction("You", "raise", 50)); // shoves preflop
  cancelPendingBotTimer(game);
  applyOpponentAction(game, bot, "call"); // calls all-in
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  const analysis = buildHandAnalysis(game);
  // Preflop all-in: every street's equity should be the exact all-in path
  for (const snap of analysis.streetSnapshots) {
    assert.equal(snap.equityIsExact, true, `${snap.street} should use the exact all-in equity path`);
    assert.equal(typeof snap.equityAtStreet, "number");
  }
  // River equity should be consistent with the actual result: a clean win/loss
  // resolves to exactly 1/0, but a split pot (tie at showdown) is a real
  // possibility with random cards and should resolve to exactly 0.5.
  const river = analysis.streetSnapshots.find((s) => s.street === "river");
  const payout = game.hand.result.payouts.get("You") || 0;
  const potEligible = (game.hand.result.pots || [])
    .filter((p) => p.eligiblePlayerIds.includes("You"))
    .reduce((s, p) => s + p.amount, 0);
  const expectedEquity = payout === 0 ? 0 : payout === potEligible ? 1 : 0.5;
  assert.equal(river.equityAtStreet, expectedEquity);
});

test("buildHandAnalysis: multi-way hand where an opponent folds is reflected in the street-by-street action log", () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" = dealer/BTN (seat0), James = SB (seat1), Victoria = BB (seat2)
  game.startNewHand();

  // Preflop: dealer acts first (You), then SB (James), then BB (Victoria)
  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);
  applyOpponentAction(game, "James", "call");
  applyOpponentAction(game, "Victoria", "check");
  assert.equal(game.hand.currentStreetName(), "flop");

  // Postflop action always starts from the SB seat (James), then BB (Victoria), then dealer (You) last
  assert.equal(game.hand.actingPlayerId(), "James");
  applyOpponentAction(game, "James", "fold");
  assert.equal(game.hand.actingPlayerId(), "Victoria");
  applyOpponentAction(game, "Victoria", "check");
  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  assert.equal(game.hand.currentStreetName(), "turn");

  // James is out, so Victoria (next live player after the SB seat) now acts first
  assert.equal(game.hand.actingPlayerId(), "Victoria");
  applyOpponentAction(game, "Victoria", "check");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  assert.equal(game.hand.currentStreetName(), "river");

  assert.equal(game.hand.actingPlayerId(), "Victoria");
  applyOpponentAction(game, "Victoria", "check");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  const analysis = buildHandAnalysis(game);
  assert.deepEqual(analysis.streetSnapshots.map((s) => s.street), ["preflop", "flop", "turn", "river"]);

  const flopActions = analysis.streetSnapshots.find((s) => s.street === "flop").actions;
  assert.deepEqual(
    flopActions.map((a) => `${a.actor}:${a.action}`),
    ["James:fold", "Victoria:check", "You:check"]
  );

  // All streets should still have a valid equity estimate for "You" (never folded)
  for (const snap of analysis.streetSnapshots) {
    assert.equal(typeof snap.equityAtStreet, "number");
    assert.ok(snap.equityAtStreet >= 0 && snap.equityAtStreet <= 1);
  }
});
