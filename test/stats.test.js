import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";

// Bot turns normally run on a real 1-2s setTimeout via checkBotTurn(). These
// tests drive bot actions directly against the underlying Hand instead, so
// they stay fast and deterministic. Any pending real bot timer scheduled by
// applyPlayerAction() is cancelled immediately after each human action.
function cancelPendingBotTimer(game) {
  if (game.botTimeout) {
    clearTimeout(game.botTimeout);
    game.botTimeout = null;
  }
}

function botId(game) {
  return game.players.find((p) => p.type === "bot").id;
}

test("VPIP counts a voluntary preflop call from the small blind", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // heads-up: "You" is SB/dealer, acts first every street
  game.startNewHand();
  const bot = botId(game);

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "call")); // voluntary: completes SB to match BB
  cancelPendingBotTimer(game);

  game.hand.applyAction(bot, "check"); // BB option closes preflop
  // Flop/turn/river: "You" (SB) acts first each street per this engine's rules
  for (let street = 0; street < 3 && !game.hand.complete; street++) {
    assert.equal(game.hand.actingPlayerId(), "You");
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) game.hand.applyAction(bot, "check");
  }
  if (game.hand.complete && game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.equal(game.stats.handsPlayed, 1);
  assert.equal(game.stats.vpipHands, 1);
});

test("VPIP does not count checking the big blind option", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1; // heads-up: bot is SB/dealer (acts first), "You" is BB
  game.startNewHand();
  const bot = botId(game);
  cancelPendingBotTimer(game); // startNewHand() may have scheduled the bot's opening action

  assert.equal(game.hand.actingPlayerId(), bot);
  game.hand.applyAction(bot, "call"); // bot completes SB to match BB

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "check")); // BB option - not voluntary
  cancelPendingBotTimer(game);

  for (let street = 0; street < 3 && !game.hand.complete; street++) {
    assert.equal(game.hand.actingPlayerId(), bot);
    game.hand.applyAction(bot, "check");
    if (!game.hand.complete) {
      assert.equal(game.hand.actingPlayerId(), "You");
      assert.ok(game.applyPlayerAction("You", "check"));
      cancelPendingBotTimer(game);
    }
  }
  if (game.hand.complete && game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.equal(game.stats.handsPlayed, 1);
  assert.equal(game.stats.vpipHands, 0);
});

test("totalInvested and netProfit track a preflop fold correctly", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" is SB
  game.startNewHand();

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "fold")); // forfeits the SB, hand ends immediately

  assert.equal(game.stats.handsPlayed, 1);
  assert.equal(game.stats.totalInvested, 5, "should contribute exactly the small blind, not 0 or the full stack");
  assert.equal(game.stats.totalWinnings, 0);
  assert.equal(game.stats.netProfit, game.stats.totalWinnings - game.stats.totalInvested);
});

test("netProfit stays consistent with totalWinnings - totalInvested across multiple hands", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;

  for (let i = 0; i < 3; i++) {
    game.dealerIndex = i % 2;
    game.startNewHand();
    cancelPendingBotTimer(game);
    const bot = botId(game);
    // Just play it out with calls/checks/folds until the hand ends, whoever acts first
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

    assert.equal(
      game.stats.netProfit,
      game.stats.totalWinnings - game.stats.totalInvested,
      `netProfit invariant should hold after hand ${i + 1}`
    );
  }
});

test("showdown tracking: showdownsSeen increments when both players see the river, showdownsWon matches the actual result", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" is SB, acts first every street
  game.startNewHand();
  const bot = botId(game);

  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);
  game.hand.applyAction(bot, "check");

  for (let street = 0; street < 3 && !game.hand.complete; street++) {
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) game.hand.applyAction(bot, "check");
  }
  const result = game.hand.result;
  const youPayout = result.payouts.get("You") || 0;
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.ok(result.showdown, "heads-up hand with no folds should reach showdown");
  assert.equal(game.stats.showdownsSeen, 1);
  assert.equal(game.stats.showdownsWon, youPayout > 0 ? 1 : 0);
});

test("folding preflop does not count as a showdown", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();
  assert.ok(game.applyPlayerAction("You", "fold"));
  assert.equal(game.stats.showdownsSeen, 0);
  assert.equal(game.stats.showdownsWon, 0);
});

test("results breakdown: winning via a fold is non-showdown winnings, distinct from a showdown win", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();
  const bot = botId(game);

  assert.ok(game.applyPlayerAction("You", "raise", 30));
  cancelPendingBotTimer(game);
  game.hand.applyAction(bot, "fold");
  if (game.hand.complete && game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.equal(game.stats.handsPlayed, 1);
  assert.equal(game.stats.showdownWinnings, 0);
  assert.ok(game.stats.nonShowdownWinnings > 0);
  assert.equal(game.stats.totalWinnings, game.stats.showdownWinnings + game.stats.nonShowdownWinnings);
});

test("biggest win/loss and current streak track correctly across hands", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;

  // Hand 1: You raise, bot folds -> win of $10 (pot 40, contributed 30)
  game.dealerIndex = 0;
  game.startNewHand();
  let bot = botId(game);
  assert.ok(game.applyPlayerAction("You", "raise", 30));
  cancelPendingBotTimer(game);
  game.hand.applyAction(bot, "fold");
  if (game.hand.complete && game.stats.handsPlayed === 0) game.handleHandComplete();
  assert.equal(game.stats.currentStreak, 1);
  assert.equal(game.stats.biggestWin, 10);

  // Hand 2: You fold preflop -> lose the $5 small blind
  game.dealerIndex = 0;
  game.startNewHand();
  assert.ok(game.applyPlayerAction("You", "fold")); // auto-completes the hand (heads-up)
  assert.equal(game.stats.currentStreak, -1);
  assert.equal(game.stats.biggestLoss, -5);

  // Hand 3: You raise, bot folds again -> win, streak flips back to +1
  game.dealerIndex = 0;
  game.startNewHand();
  bot = botId(game);
  assert.ok(game.applyPlayerAction("You", "raise", 30));
  cancelPendingBotTimer(game);
  game.hand.applyAction(bot, "fold");
  if (game.hand.complete && game.stats.handsPlayed === 2) game.handleHandComplete();
  assert.equal(game.stats.currentStreak, 1);
});

test("PFR% counts an unopened preflop raise, not a call or a 3-bet", () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" is BTN/dealer, acts first preflop 3-handed
  game.startNewHand();
  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "raise", 30)); // open-raise = PFR, not a 3-bet
  cancelPendingBotTimer(game);

  assert.equal(game.stats.pfrHands, 1);
  assert.equal(game.stats.threeBetHands, 0);
  assert.equal(game.stats.threeBetOpportunities, 0);
});

test("3-Bet% counts a preflop raise made after facing exactly one prior raise", () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1; // James=BTN (acts first), Victoria=SB, "You"=BB
  game.startNewHand();

  assert.equal(game.hand.actingPlayerId(), "James");
  game.hand.applyAction("James", "raise", 30); // open
  assert.equal(game.hand.actingPlayerId(), "Victoria");
  game.hand.applyAction("Victoria", "call");

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "raise", 90)); // 3-bet
  cancelPendingBotTimer(game);

  assert.equal(game.stats.pfrHands, 0, "raising after facing a raise is a 3-bet, not an open");
  assert.equal(game.stats.threeBetHands, 1);
  assert.equal(game.stats.threeBetOpportunities, 1);
});

test("3-Bet opportunity is counted even if You just call the raise instead of 3-betting", () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1;
  game.startNewHand();

  game.hand.applyAction("James", "raise", 30);
  game.hand.applyAction("Victoria", "call");
  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "call")); // declines to 3-bet
  cancelPendingBotTimer(game);

  assert.equal(game.stats.threeBetHands, 0);
  assert.equal(game.stats.threeBetOpportunities, 1, "should still count as an opportunity even though You didn't take it");
});

test("All-In EV wiring: allInHandsTracked/cumulativeEVDollars/luckDollars stay internally consistent, and the handLog entry gets a non-null allInEV", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 50, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" is SB, acts first
  game.startNewHand();
  const bot = botId(game);

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "raise", 50)); // shoves the rest of the stack
  cancelPendingBotTimer(game);
  game.hand.applyAction(bot, "call"); // calls all-in preflop
  if (game.hand.complete && game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.ok(game.hand.allInSnapshot, "both players should be all-in preflop");
  assert.equal(game.stats.allInHandsTracked, 1);
  assert.equal(game.handLog.length, 1);
  assert.notEqual(game.handLog[0].allInEV, null);
  assert.equal(game.handLog[0].allInEV, game.stats.cumulativeEVDollars);

  const actualNet = game.handLog[0].net;
  assert.ok(Math.abs(game.stats.luckDollars - (actualNet - game.stats.cumulativeEVDollars)) < 1e-9);
});

test("All-In EV stats are not touched by a normal (non-all-in) hand", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0;
  game.startNewHand();

  assert.ok(game.applyPlayerAction("You", "fold"));

  assert.equal(game.stats.allInHandsTracked, 0);
  assert.equal(game.stats.cumulativeEVDollars, 0);
  assert.equal(game.stats.luckDollars, 0);
  assert.equal(game.handLog[0].allInEV, null);
});
