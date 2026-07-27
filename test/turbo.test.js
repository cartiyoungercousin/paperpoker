import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";

function cancelPendingBotTimer(game) {
  if (game.botTimeout) {
    clearTimeout(game.botTimeout);
    game.botTimeout = null;
  }
}

test("turboMode defaults to off", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.turboMode, false);
});

test("bot turn delay is short (turbo) vs. normal, based on turboMode", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1; // heads-up: bot is SB/dealer, acts first - checkBotTurn() fires immediately
  game.startNewHand();

  assert.ok(game._lastBotDelay >= 1000 && game._lastBotDelay < 2000, "normal delay should be 1-2s");
  cancelPendingBotTimer(game);

  game.turboMode = true;
  game.startNewHand(); // re-deal so checkBotTurn() runs again with turbo on
  assert.ok(game._lastBotDelay >= 50 && game._lastBotDelay < 150, "turbo delay should be 50-150ms");
  cancelPendingBotTimer(game);
});

test("turboMode survives updateSettings (a session-level pacing preference, not a game-state reset)", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.turboMode = true;
  game.updateSettings({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.turboMode, true);
});

// Regression test: ranked promises "no turbo, same conditions for everyone"
// (see #ranked-setup-fixed-hint in index.html) - RANKED_FIXED_SETTINGS
// explicitly includes turboMode: false specifically so entering ranked
// forces it off even if it was left on from an earlier unranked/
// experimental game in the same session.
test("updateSettings forces turboMode off when the config explicitly says so (ranked's fixed settings)", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.turboMode = true;
  game.updateSettings({ numPlayers: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20, turboMode: false });
  assert.equal(game.turboMode, false);
});
