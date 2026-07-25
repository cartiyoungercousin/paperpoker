import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";

function cancelPendingBotTimer(game) {
  if (game.botTimeout) {
    clearTimeout(game.botTimeout);
    game.botTimeout = null;
  }
}

function botId(game) {
  return game.players.find((p) => p.type === "bot").id;
}

test("handLog records one entry per hand You were dealt into, with internally consistent fields", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;

  for (let i = 0; i < 3; i++) {
    game.dealerIndex = i % 2;
    game.startNewHand();
    cancelPendingBotTimer(game);
    const bot = botId(game);
    let guard = 0;
    while (!game.hand.complete && guard++ < 50) {
      const actingId = game.hand.actingPlayerId();
      if (actingId === "You") {
        const legal = game.hand.legalActions("You");
        const action = legal.check ? "check" : "call";
        assert.ok(game.applyPlayerAction("You", action));
        cancelPendingBotTimer(game);
      } else {
        const legal = game.hand.legalActions(bot);
        const action = legal.check ? "check" : "call";
        game.hand.applyAction(bot, action);
      }
    }
    if (game.hand.complete && game.stats.handsPlayed === i) game.handleHandComplete();
  }

  assert.equal(game.handLog.length, 3);
  game.handLog.forEach((record, i) => {
    assert.equal(record.handNumber, i + 1);
    assert.equal(record.net, record.payout - record.contributed, "net should equal payout minus contributed");
    assert.ok(["SB", "BB", "BTN", "other"].includes(record.position));
    assert.equal(record.holeCards.length, 2);
    assert.ok(Array.isArray(record.board));
    assert.equal(typeof record.wentToShowdown, "boolean");
    assert.equal(record.allInEV, null, "allInEV is populated in a later phase, should stay null for now");
  });
});

test("handLog position matches the hand's actual small/big blind assignment", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // heads-up: "You" is SB/dealer
  game.startNewHand();
  assert.ok(game.applyPlayerAction("You", "fold"));

  assert.equal(game.handLog.length, 1);
  assert.equal(game.handLog[0].position, "SB");
});

test("handleHandComplete does not append a handLog record when You aren't part of the hand", () => {
  // startNewHand() always tops up a busted "You" back to startingStack before dealing,
  // so this can't happen via normal play - construct the scenario directly instead, as
  // defensive coverage for the youDealtIn guard in handleHandComplete().
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();
  const bot = botId(game);
  assert.ok(game.applyPlayerAction("You", "fold"));
  const handsBefore = game.handLog.length;

  // Re-run handleHandComplete against a hand whose order doesn't include "You"
  game.hand.order = game.hand.order.filter((id) => id !== "You");
  game.handleHandComplete();

  assert.equal(game.handLog.length, handsBefore, "no new record should be appended for a hand You aren't part of");
});
