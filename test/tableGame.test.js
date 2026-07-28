import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";
import { xpForHand } from "../src/rankTiers.js";
import { RANKED_FIXED_SETTINGS } from "../src/rankedConfig.js";
import { RUMBLE_FIXED_SETTINGS, RUMBLE_HANDS_TOTAL, RUMBLE_WIN_COINS_REWARD } from "../src/rumbleConfig.js";
import { TOURNAMENT_FIXED_SETTINGS, TOURNAMENT_ROUND_HANDS_TOTAL, TOURNAMENT_ROUNDS_TOTAL } from "../src/tournamentConfig.js";
import { HEADS_UP_ONLY_DIFFICULTIES, BOARDROOM_CHARACTERS } from "../src/tableGame.js";
import { computeHandCoinsDelta } from "../src/coins.js";
import { findPowerUp } from "../src/powerUps.js";

function cancelPendingBotTimer(game) {
  if (game.botTimeout) {
    clearTimeout(game.botTimeout);
    game.botTimeout = null;
  }
}

// Plays out a heads-up hand as a check-down to showdown. A tie/chop is
// possible here (both players playing the board, for instance) - callers
// should read the actual payout from game.hand.result rather than assuming
// a winner from the net stack change, which a chop can make disagree with
// TableGame's own real win/loss definition.
function playHeadsUpCheckdown(game) {
  game.dealerIndex = 1; // "You" is seat 0 - bot is dealer/SB, acts first preflop
  game.startNewHand();
  cancelPendingBotTimer(game);
  let guard = 0;
  while (!game.hand.complete && guard++ < 50) {
    const actingId = game.hand.actingPlayerId();
    const legal = game.hand.legalActions(actingId);
    const action = legal.check ? "check" : "call";
    if (actingId === "You") game.applyPlayerAction("You", action);
    else {
      game.hand.applyAction(actingId, action);
      if (game.hand.complete) game.handleHandComplete();
    }
  }
}

// Forces a deterministic win of a known-ish size for "You": the bot (SB)
// just calls preflop, "You" (BB) raises to raiseAmount, and the bot is
// forced to fold - bypassing the bot's own (probabilistic) decision logic
// entirely, unlike playHeadsUpCheckdown's random check-down. Callers should
// still read the actual payout/contributed from game.hand.result rather
// than assuming raiseAmount exactly, since blinds/calls add a little on top.
function playForcedRaiseAndFold(game, raiseAmount) {
  game.dealerIndex = 1; // bot is SB/dealer, acts first preflop
  game.startNewHand();
  cancelPendingBotTimer(game);
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand.applyAction(botId, "call"); // bot completes SB to match BB
  game.applyPlayerAction("You", "raise", raiseAmount); // "You" (BB) raises
  cancelPendingBotTimer(game);
  game.hand.applyAction(botId, "fold");
  if (game.hand.complete) game.handleHandComplete();
}

test("a ranked hand emits 'xpEarned' with the correct win/loss delta for the difficulty", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, difficulty: "medium" });
  game.gameStarted = true;
  game.setRankedMode(true, 42);

  let xpEvent = null;
  game.on("xpEarned", (payload) => { xpEvent = payload; });

  playHeadsUpCheckdown(game);

  assert.ok(xpEvent, "expected an xpEarned event for a ranked hand You were dealt into");
  assert.equal(xpEvent.userId, 42);
  // Matches TableGame's own youWon definition (payout > 0) exactly, rather
  // than re-deriving it from the net stack change - those two can disagree
  // on a chopped/split pot (a real payout, but zero net change), which is
  // exactly what made this test occasionally flaky before this fix.
  const payout = game.hand.result.payouts.get("You") || 0;
  const expectedWin = payout > 0;
  // XP scales with the size of YOUR OWN win/loss (see rankTiers.test.js for
  // the formula itself), not the hand's total pot size - compute the same
  // way TableGame does rather than assuming the flat base amount.
  const contributed = game.hand.totalContributed.get("You") || 0;
  const expectedDelta = xpForHand("medium", expectedWin, Math.abs(payout - contributed), game.startingStack);
  assert.equal(xpEvent.delta, expectedDelta);
});

test("an unranked hand never emits 'xpEarned'", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  // ranked defaults to false - never called setRankedMode at all

  let xpEventFired = false;
  game.on("xpEarned", () => { xpEventFired = true; });

  playHeadsUpCheckdown(game);
  assert.equal(xpEventFired, false);
});

test("setRankedMode refuses ranked mode without a userId, even if 'ranked' is passed as true", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setRankedMode(true, null);
  assert.equal(game.ranked, false);
  assert.equal(game.userId, null);

  let xpEventFired = false;
  game.on("xpEarned", () => { xpEventFired = true; });
  playHeadsUpCheckdown(game);
  assert.equal(xpEventFired, false);
});

test("an unranked hand emits 'coinsEarned' for a logged-in human, unlike xpEarned which is ranked-only", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(99); // logged in, but never called setRankedMode - this hand is unranked

  let coinsEvent = null;
  let xpEventFired = false;
  game.on("coinsEarned", (payload) => { coinsEvent = payload; });
  game.on("xpEarned", () => { xpEventFired = true; });

  playHeadsUpCheckdown(game);

  assert.ok(coinsEvent, "expected coinsEarned for a logged-in player even in an unranked hand");
  assert.equal(coinsEvent.userId, 99);
  assert.equal(xpEventFired, false, "unranked should still never emit xpEarned");
});

test("a ranked hand emits 'xpEarned' but never 'coinsEarned' - Ranked is a pure skill ladder, no coins involved at all", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(7);
  game.setRankedMode(true, 7);

  let coinsEventFired = false;
  let xpEventFired = false;
  game.on("coinsEarned", () => { coinsEventFired = true; });
  game.on("xpEarned", () => { xpEventFired = true; });

  playHeadsUpCheckdown(game);

  assert.equal(coinsEventFired, false);
  assert.equal(xpEventFired, true);
});

test("a guest (no humanUserId set) never emits 'coinsEarned'", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  // setHumanUserId never called - a logged-out visitor

  let coinsEventFired = false;
  game.on("coinsEarned", () => { coinsEventFired = true; });
  playHeadsUpCheckdown(game);
  assert.equal(coinsEventFired, false);
});

test("setHumanUserId(null) (e.g. logging out mid-session) stops further coinsEarned events", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(5);
  game.setHumanUserId(null);

  let coinsEventFired = false;
  game.on("coinsEarned", () => { coinsEventFired = true; });
  playHeadsUpCheckdown(game);
  assert.equal(coinsEventFired, false);
});

// ===== Unranked coins: difficulty-keyed reward (wired through
// computeHandCoinsDelta, see test/coins.test.js for the pure-function cases) =====

test("an unranked win's coinsEarned delta/tier matches computeHandCoinsDelta for the game's actual difficulty", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, difficulty: "hard" });
  game.gameStarted = true;
  game.setHumanUserId(55);

  let coinsEvent = null;
  game.on("coinsEarned", (payload) => { coinsEvent = payload; });

  playForcedRaiseAndFold(game, 300);

  const expected = computeHandCoinsDelta({ difficulty: "hard", won: true });

  assert.equal(coinsEvent.delta, expected.delta);
  assert.equal(coinsEvent.tier, expected.tier);
  assert.equal(coinsEvent.delta, 6, "Hard's win amount");
});

test("a ranked hand never emits coinsEarned at all, regardless of win size - Ranked earns no coins", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(66);
  game.setRankedMode(true, 66);

  let coinsEvent = null;
  game.on("coinsEarned", (payload) => { coinsEvent = payload; });

  playForcedRaiseAndFold(game, 300); // a big win, which would pay well if this were unranked

  assert.equal(coinsEvent, null);
});

test("three unranked wins in a row each pay the same flat per-difficulty amount - no streak bonus", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 5000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(77);

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));

  playForcedRaiseAndFold(game, 50);
  playForcedRaiseAndFold(game, 50);
  playForcedRaiseAndFold(game, 50);

  assert.equal(coinsEvents.length, 3);
  assert.deepEqual(coinsEvents.map((e) => e.delta), [2, 2, 2], "Easy's flat win amount every time, no escalation");
  assert.ok(!("streakBonus" in coinsEvents[2]), "streakBonus no longer exists on the payload");
});

test("updateSettings resets ranked mode back to false (a new game always starts unranked)", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.setRankedMode(true, 7);
  assert.equal(game.ranked, true);

  game.updateSettings({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.ranked, false);
  assert.equal(game.userId, null);
});

test("updateSettings stores shotClockSeconds, and getState()/getStateFor() echo it back - the server-confirmed value the client should actually trust", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.getState().shotClockSeconds, 0, "no time limit by default");

  game.updateSettings({ shotClockSeconds: 60 });
  assert.equal(game.shotClockSeconds, 60);
  assert.equal(game.getState().shotClockSeconds, 60);

  game.gameStarted = true;
  game.startNewHand();
  cancelPendingBotTimer(game);
  assert.equal(game.getState().shotClockSeconds, 60, "still echoed once a hand is actually in progress");
});

test("updateSettings(0) explicitly clears the shot clock rather than being ignored like the other zero/falsy fields", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.updateSettings({ shotClockSeconds: 45 });
  assert.equal(game.shotClockSeconds, 45);

  game.updateSettings({ shotClockSeconds: 0 });
  assert.equal(game.shotClockSeconds, 0, "0 is a real 'no time limit' choice, not a no-op like startingStack: 0 would be");
});

test("ranked forces the shot clock to 15 seconds regardless of what the client asked for - the exact bug that used to let 60s leak into ranked", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  // Mirrors exactly what server.js's updateSettings handler does for a ranked request:
  // RANKED_FIXED_SETTINGS spread over whatever the client sent, client's own
  // shotClockSeconds never even reaches this call.
  game.updateSettings({ ...RANKED_FIXED_SETTINGS, difficulty: "easy" });
  game.setRankedMode(true, 7);

  assert.equal(RANKED_FIXED_SETTINGS.shotClockSeconds, 15, "sanity check on the fixture itself");
  assert.equal(game.shotClockSeconds, 15);
  assert.equal(game.getState().shotClockSeconds, 15, "and it actually reaches the payload the client reads its timer from");
});

test("getState() exposes the current ranked flag, both with and without an active hand", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.getState().ranked, false);

  game.setRankedMode(true, 7);
  assert.equal(game.getState().ranked, true);

  game.gameStarted = true;
  game.startNewHand();
  cancelPendingBotTimer(game);
  assert.equal(game.getState().ranked, true);
});

// Regression coverage for a real user report: after a raise war, the Call
// button's amount looked "too low" - it wasn't a bug, it's standard poker
// convention (the amount is the INCREMENTAL chips you still need to add,
// not the table's total bet, since you may have already put some in this
// street from your own earlier raise). legalActions.currentBet exposes the
// street's actual total bet level so the client can show both numbers
// clearly, without changing what callAmount itself means.
test("getStateFor: legalActions.currentBet is the street's total bet level, distinct from callAmount once the viewer already has chips in from their own earlier raise", () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 0; // "You" = dealer/BTN (acts first preflop), James = SB, Victoria = BB
  game.startNewHand();

  assert.equal(game.hand.actingPlayerId(), "You");
  assert.ok(game.applyPlayerAction("You", "raise", 50)); // "You" opens to 50 (contributed: 50)
  cancelPendingBotTimer(game);

  assert.equal(game.hand.actingPlayerId(), "James");
  game.hand.applyAction("James", "raise", 150); // James re-raises to 150

  assert.equal(game.hand.actingPlayerId(), "Victoria");
  game.hand.applyAction("Victoria", "fold");

  assert.equal(game.hand.actingPlayerId(), "You");
  const state = game.getStateFor("You");
  assert.ok(state.legalActions);
  assert.equal(state.legalActions.currentBet, 150, "the street's total bet level after James's re-raise");
  assert.equal(state.legalActions.callAmount, 100, "You already has 50 in from their own raise, so only 100 more closes the gap to 150");
  assert.ok(state.legalActions.callAmount < state.legalActions.currentBet, "the incremental call amount reads lower than the total bet whenever the viewer already has chips in this street - this is correct, not a bug");
});

// Folding every time it's "You"'s turn, regardless of hand strength, makes
// the per-hand loss fully deterministic (either the small or big blind,
// whichever "You" posted that hand) - unlike a showdown, there's no reliance
// on how the random deck happened to come out.
function foldEveryHumanTurn(game) {
  let guard = 0;
  while (!game.hand.complete && guard++ < 20) {
    const actingId = game.hand.actingPlayerId();
    if (actingId === "You") {
      game.applyPlayerAction("You", "fold");
    } else {
      const legal = game.hand.legalActions(actingId);
      game.hand.applyAction(actingId, legal.check ? "check" : "call");
      if (game.hand.complete) game.handleHandComplete();
    }
  }
}

test("a single-hand ranked session ends after exactly one hand, regardless of outcome", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, difficulty: "easy" });
  game.gameStarted = true;
  game.setRankedMode(true, 7, 0); // 0 = single hand

  let sessionComplete = null;
  game.on("rankedSessionComplete", (payload) => { sessionComplete = payload; });

  playHeadsUpCheckdown(game);

  assert.ok(sessionComplete, "expected the session to complete after the one hand");
  assert.equal(sessionComplete.handsPlayed, 1);
  assert.equal(game.ranked, false, "ranked mode should be cleared once the session completes");
});

test("a ranked tournament ends after its configured hand count, with bustedOut false", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, difficulty: "easy" });
  game.gameStarted = true;
  game.setRankedMode(true, 7, 2); // a 2-hand tournament

  let sessionComplete = null;
  game.on("rankedSessionComplete", (payload) => { sessionComplete = payload; });

  playHeadsUpCheckdown(game);
  assert.equal(sessionComplete, null, "should not complete after only 1 of 2 hands");
  assert.equal(game.ranked, true);

  game.startNewHand();
  cancelPendingBotTimer(game);
  playHeadsUpCheckdown(game);

  assert.ok(sessionComplete, "expected the tournament to complete after its 2nd hand");
  assert.equal(sessionComplete.handsPlayed, 2);
  assert.equal(sessionComplete.bustedOut, false);
  assert.equal(game.ranked, false);
});

test("a ranked tournament ends early on a bust, before its configured hand count is reached", () => {
  // A small starting stack relative to the blinds means a folded blind or two
  // is enough to fall under the big blind and end the session early.
  const game = new TableGame({ numPlayers: 2, startingStack: 25, smallBlind: 5, bigBlind: 10, difficulty: "easy" });
  game.gameStarted = true;
  game.setRankedMode(true, 7, 50); // a long tournament - should still end early

  let sessionComplete = null;
  game.on("rankedSessionComplete", (payload) => { sessionComplete = payload; });

  let iterations = 0;
  while (!sessionComplete && iterations++ < 20) {
    game.startNewHand();
    cancelPendingBotTimer(game);
    foldEveryHumanTurn(game);
  }

  assert.ok(sessionComplete, "expected a bust to end the tournament within a reasonable number of hands");
  assert.equal(sessionComplete.bustedOut, true);
  assert.ok(sessionComplete.handsPlayed < 50, "should have ended well before the configured 50 hands");
  assert.equal(game.ranked, false);
});

// ===== Phase 7: heads-up-only experimental bots + The Boardroom =====

test("starting any heads-up-only difficulty seats exactly 2 players, regardless of the client-requested numPlayers", () => {
  for (const difficulty of HEADS_UP_ONLY_DIFFICULTIES) {
    const game = new TableGame({ numPlayers: 6, difficulty });
    assert.equal(game.players.length, 2, `${difficulty} should force a 2-player table at construction`);

    // Also true after a settings change, not just at construction - the same
    // "server/table never trusts the client-requested count" rule.
    const other = new TableGame({ numPlayers: 6, difficulty: "easy" });
    other.updateSettings({ numPlayers: 6, difficulty });
    assert.equal(other.players.length, 2, `${difficulty} should force a 2-player table via updateSettings too`);
  }
});

test("starting The Boardroom seats the full 6-character cast regardless of the client-requested numPlayers", () => {
  const game = new TableGame({ numPlayers: 2, difficulty: "boardroom" });
  assert.equal(game.players.length, 1 + BOARDROOM_CHARACTERS.length);

  const other = new TableGame({ numPlayers: 2, difficulty: "easy" });
  other.updateSettings({ numPlayers: 2, difficulty: "boardroom" });
  assert.equal(other.players.length, 1 + BOARDROOM_CHARACTERS.length);
});

test("The Boardroom's bot seats are labeled with their character's actual name, not a generic BOT_NAMES pool name", () => {
  const game = new TableGame({ difficulty: "boardroom" });
  const bots = game.players.filter((p) => p.type === "bot");
  assert.equal(bots.length, BOARDROOM_CHARACTERS.length);

  const expectedNames = new Set(BOARDROOM_CHARACTERS.map((c) => c.name));
  for (const bot of bots) {
    assert.ok(expectedNames.has(bot.displayName), `expected ${bot.id}'s displayName to be a Boardroom character name, got ${bot.displayName}`);
  }
  // Every character appears exactly once - a full, non-duplicated cast.
  const seatedNames = bots.map((b) => b.displayName).sort();
  assert.deepEqual(seatedNames, [...expectedNames].sort());
});

test("a non-Boardroom, non-heads-up-only difficulty is unaffected by the seat-forcing logic", () => {
  const game = new TableGame({ numPlayers: 4, difficulty: "medium" });
  assert.equal(game.players.length, 4);
});

test("_personaForBot resolves each Boardroom seat to its own persona, and every other difficulty to a single table-wide persona", () => {
  const boardroom = new TableGame({ difficulty: "boardroom" });
  for (const character of BOARDROOM_CHARACTERS) {
    assert.equal(boardroom._personaForBot(character.key), character.key);
  }

  const drunk = new TableGame({ difficulty: "drunk" });
  assert.equal(drunk._personaForBot("James"), "drunk");

  const easy = new TableGame({ difficulty: "easy" });
  assert.equal(easy._personaForBot("James"), "sober");
});

test("_usedDialogueLines resets at the start of every hand, so a bot can reuse a line across hands but not within one", () => {
  const game = new TableGame({ numPlayers: 3, difficulty: "easy" });
  game.gameStarted = true;
  game._usedDialogueLines.add("some line from a previous hand");
  game.startNewHand();
  assert.equal(game._usedDialogueLines.size, 0);
});

test("_speakBotChat never repeats a line within the same hand across many calls, until a bank would be exhausted", () => {
  const game = new TableGame({ numPlayers: 2, difficulty: "rock" });
  game.gameStarted = true;
  game.startNewHand();

  const seenTexts = [];
  game.on("botChat", ({ text }) => seenTexts.push(text));
  // Rock's banter bank is intentionally small (~12 lines) - drawing well
  // beyond that size should still never throw, and should only repeat a
  // line after every distinct line has already appeared at least once.
  for (let i = 0; i < 30; i++) game._speakBotChat("banter");

  const firstRepeatIndex = seenTexts.findIndex((text, idx) => seenTexts.slice(0, idx).includes(text));
  const distinctBeforeFirstRepeat = new Set(seenTexts.slice(0, firstRepeatIndex + 1)).size;
  assert.ok(distinctBeforeFirstRepeat >= 10, "expected most of Rock's banter bank to be exhausted before any repeat");
});

// ===== Room mode: per-seat coins (bug fix - previously only ever checked
// for a solo "You" seat, so no room player could ever earn coins) =====

function playRoomHeadsUpCheckdown(game, idA, idB) {
  game.startNewHand();
  let guard = 0;
  while (!game.hand.complete && guard++ < 50) {
    const actingId = game.hand.actingPlayerId();
    const legal = game.hand.legalActions(actingId);
    const action = legal.check ? "check" : "call";
    game.applyPlayerAction(actingId, action);
  }
  if (game.stats.handsPlayed === 0) game.handleHandComplete();
}

test("addPlayer with a userId records it in playerUserIds; without one, it's simply absent", () => {
  const game = new TableGame({ roomMode: true });
  game.addPlayer({ id: "sess-a", displayName: "Alice", userId: 101 });
  game.addPlayer({ id: "sess-b", displayName: "Bob" }); // guest, no account

  assert.equal(game.playerUserIds.get("sess-a"), 101);
  assert.equal(game.playerUserIds.has("sess-b"), false);
});

test("a room hand emits a separate 'coinsEarned' for each logged-in seat dealt into it, with their own userId", () => {
  const game = new TableGame({ roomMode: true, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.addPlayer({ id: "sess-a", displayName: "Alice", userId: 101 });
  game.addPlayer({ id: "sess-b", displayName: "Bob", userId: 202 });
  game.gameStarted = true;

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  playRoomHeadsUpCheckdown(game, "sess-a", "sess-b");

  assert.equal(coinsEvents.length, 2, "both logged-in seats should each earn coins for this hand");
  const userIds = coinsEvents.map((e) => e.userId).sort();
  assert.deepEqual(userIds, [101, 202]);
});

test("a guest seat (no userId) in a room never emits 'coinsEarned' for itself, but a logged-in seat at the same table still does", () => {
  const game = new TableGame({ roomMode: true, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.addPlayer({ id: "sess-a", displayName: "Alice", userId: 101 });
  game.addPlayer({ id: "sess-b", displayName: "Bob" }); // guest
  game.gameStarted = true;

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  playRoomHeadsUpCheckdown(game, "sess-a", "sess-b");

  assert.equal(coinsEvents.length, 1, "only the logged-in seat should earn coins");
  assert.equal(coinsEvents[0].userId, 101);
});

// ===== Rumble mode =====

function makeRumbleGame(extra = {}) {
  const game = new TableGame({
    numPlayers: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20,
    rumbleMode: true, difficulty: "easy", ...extra,
  });
  game.gameStarted = true;
  game.dealerIndex = 1; // bot is dealer/SB, acts first preflop - "You" is BB
  return game;
}

// Plays whatever hand is already in progress (game.hand must already be set,
// via startNewHand()) to completion as a plain check/call-down.
function playCurrentRumbleHandToCheckdown(game) {
  cancelPendingBotTimer(game);
  let guard = 0;
  while (!game.hand.complete && guard++ < 50) {
    const actingId = game.hand.actingPlayerId();
    const legal = game.hand.legalActions(actingId);
    const action = legal.check ? "check" : "call";
    if (actingId === "You") game.applyPlayerAction("You", action);
    else {
      game.hand.applyAction(actingId, action);
      if (game.hand.complete) game.handleHandComplete();
    }
    cancelPendingBotTimer(game);
  }
}

test("updateSettings with rumbleMode:true sets rumbleMode and applies RUMBLE_FIXED_SETTINGS", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.rumbleMode, false);
  game.updateSettings({ ...RUMBLE_FIXED_SETTINGS, difficulty: "easy", rumbleMode: true });
  assert.equal(game.rumbleMode, true);
  assert.equal(game.startingStack, RUMBLE_FIXED_SETTINGS.startingStack);
  assert.equal(game.shotClockSeconds, RUMBLE_FIXED_SETTINGS.shotClockSeconds);
});

test("updateSettings resets rumbleMode/power-ups/hand count back to a clean slate for the next game", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  assert.ok(game.rumblePowerUps.size > 0);
  game.updateSettings({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.rumbleMode, false);
  assert.equal(game.rumblePowerUps.size, 0);
  assert.equal(game.rumbleHandsPlayed, 0);
});

test("rumble power-ups are assigned exactly once per session and persist unchanged across multiple hands", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const firstAssignment = new Map(game.rumblePowerUps);
  assert.equal(firstAssignment.size, 2);
  playCurrentRumbleHandToCheckdown(game);

  game.startNewHand();
  assert.deepEqual(game.rumblePowerUps, firstAssignment, "the second hand should not re-deal power-ups");
});

test("every seated player gets a real, distinct power-up from the catalog when the table matches the catalog size", () => {
  const game = new TableGame({ numPlayers: 6, ...RUMBLE_FIXED_SETTINGS, rumbleMode: true, difficulty: "easy" });
  game.gameStarted = true;
  game.startNewHand();
  const keys = [...game.rumblePowerUps.values()].map((e) => e.key);
  assert.equal(keys.length, 6);
  assert.equal(new Set(keys).size, 6, "6 players against exactly 6 catalog entries should mean no duplicates");
  for (const entry of game.rumblePowerUps.values()) assert.equal(entry.used, false);
});

test("applyPowerUp refuses outside rumble mode and off-turn, returning an error object rather than throwing", () => {
  const rumble = makeRumbleGame();
  rumble.startNewHand();
  cancelPendingBotTimer(rumble);
  // Not this player's turn (bot acts first preflop, heads-up dealer=bot)
  const offTurn = rumble.applyPowerUp("You", null);
  assert.equal(offTurn.ok, false);
  assert.equal(typeof offTurn.error, "string");

  const nonRumble = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  nonRumble.gameStarted = true;
  nonRumble.dealerIndex = 1;
  nonRumble.startNewHand();
  cancelPendingBotTimer(nonRumble);
  assert.equal(nonRumble.applyPowerUp("You", null).ok, false, "power-ups don't exist outside rumble mode");
});

test("applyPowerUp broadcasts a public reveal to everyone, marks the power-up used, and refuses a second use", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  cancelPendingBotTimer(game);
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand.applyAction(botId, "call"); // now "You"'s turn

  const entry = game.rumblePowerUps.get("You");
  const needsTarget = findPowerUp(entry.key).needsTarget;
  const revealed = [];
  game.on("powerUpActivated", (p) => revealed.push(p));

  const result = game.applyPowerUp("You", needsTarget ? botId : undefined);
  assert.equal(result.ok, true);
  assert.equal(revealed.length, 1);
  assert.equal(revealed[0].playerId, "You");
  assert.equal(revealed[0].key, entry.key);
  assert.equal(game.rumblePowerUps.get("You").used, true);

  const second = game.applyPowerUp("You", needsTarget ? botId : undefined);
  assert.equal(second.ok, false);
  assert.equal(revealed.length, 1, "no second reveal should have broadcast");
});

test("a rumble tournament ends after exactly RUMBLE_HANDS_TOTAL hands, with standings/winners matching the real final stacks", () => {
  const game = makeRumbleGame();
  let sessionComplete = null;
  game.on("rumbleSessionComplete", (payload) => { sessionComplete = payload; });

  for (let i = 0; i < RUMBLE_HANDS_TOTAL; i++) {
    game.startNewHand();
    playCurrentRumbleHandToCheckdown(game);
    if (i < RUMBLE_HANDS_TOTAL - 1) {
      assert.equal(sessionComplete, null, `should not complete before hand ${RUMBLE_HANDS_TOTAL}`);
    }
  }

  assert.ok(sessionComplete, "expected rumbleSessionComplete after the final hand");
  assert.equal(sessionComplete.handsPlayed, RUMBLE_HANDS_TOTAL);
  assert.equal(game.rumbleHandsPlayed, RUMBLE_HANDS_TOTAL);

  const actualStacks = new Map(game.players.map((p) => [p.id, p.stack]));
  for (const s of sessionComplete.standings) assert.equal(s.stack, actualStacks.get(s.id));
  for (let i = 1; i < sessionComplete.standings.length; i++) {
    assert.ok(sessionComplete.standings[i - 1].stack >= sessionComplete.standings[i].stack, "standings should be sorted highest-to-lowest");
  }
  const maxStack = Math.max(...sessionComplete.standings.map((s) => s.stack));
  const expectedWinners = sessionComplete.standings.filter((s) => s.stack === maxStack).map((s) => s.id).sort();
  assert.deepEqual([...sessionComplete.winners].sort(), expectedWinners);
});

test("startNewHand refuses to deal another hand once the rumble tournament is already complete", () => {
  const game = makeRumbleGame();
  for (let i = 0; i < RUMBLE_HANDS_TOTAL; i++) {
    game.startNewHand();
    playCurrentRumbleHandToCheckdown(game);
  }
  const handCountAfterTournament = game.handCount;
  game.startNewHand(); // should be a no-op
  assert.equal(game.handCount, handCountAfterTournament, "no 6th hand should have been dealt");
});

test("all-in equity/luck stats are skipped entirely for rumble hands", () => {
  const game = makeRumbleGame({ startingStack: 40 });
  game.startNewHand();
  cancelPendingBotTimer(game);
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand.applyAction(botId, "raise", 40);
  game.applyPlayerAction("You", "call");
  cancelPendingBotTimer(game);
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.equal(game.stats.allInHandsTracked, 0, "rumble hands should never populate the all-in-equity stat");
});

test("an ordinary rumble hand mid-session (not the session-ending one) never emits coinsEarned", () => {
  const game = makeRumbleGame();
  game.setHumanUserId(99);
  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  game.startNewHand();
  playCurrentRumbleHandToCheckdown(game);
  assert.equal(coinsEvents.length, 0);
});

// Direct state manipulation (same technique the tournament round-outcome
// tests use) rather than forcing an exact numeric outcome through real
// random-deck play over a full 5-hand session.
test("the session-ending rumble hand emits coinsEarned (+2, tier:'rumble') when 'You' end on top", () => {
  const game = makeRumbleGame();
  game.setHumanUserId(99);
  game.rumbleHandsPlayed = RUMBLE_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 1200;
  game.players.find((p) => p.id === botId).stack = 800;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  game.handleHandComplete();

  assert.equal(coinsEvents.length, 1);
  assert.deepEqual(coinsEvents[0], { userId: 99, delta: RUMBLE_WIN_COINS_REWARD, tier: "rumble" });
});

test("the session-ending rumble hand emits nothing when 'You' end strictly behind - a loss costs nothing but pays nothing", () => {
  const game = makeRumbleGame();
  game.setHumanUserId(99);
  game.rumbleHandsPlayed = RUMBLE_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 800;
  game.players.find((p) => p.id === botId).stack = 1200;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  game.handleHandComplete();

  assert.equal(coinsEvents.length, 0);
});

test("an exact tie for the top stack still pays the coin reward - co-winners both count as a win here, unlike Tournament's strict rule", () => {
  const game = makeRumbleGame();
  game.setHumanUserId(99);
  game.rumbleHandsPlayed = RUMBLE_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 1000;
  game.players.find((p) => p.id === botId).stack = 1000;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  game.handleHandComplete();

  assert.equal(coinsEvents.length, 1);
  assert.equal(coinsEvents[0].delta, RUMBLE_WIN_COINS_REWARD);
});

test("a rumble session-ending win for a guest (no humanUserId) emits no coinsEarned", () => {
  const game = makeRumbleGame();
  game.rumbleHandsPlayed = RUMBLE_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 1200;
  game.players.find((p) => p.id === botId).stack = 800;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  game.handleHandComplete();

  assert.equal(coinsEvents.length, 0);
});

// ===== _applyRumblePayoutAdjustments (Insurance / Bounty Hunter) =====

test("_applyRumblePayoutAdjustments refunds 50% of a big loss for an Insurance-flagged player", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleInsurancePlayers = new Set(["You"]);
  game.hand.totalContributed.set("You", 600); // >= 50% of the 1000 starting stack
  game.hand.result = { payouts: new Map([["You", 0], [botId, 1200]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 300, "50% of the 600 lost");
});

test("_applyRumblePayoutAdjustments does not refund Insurance below the 50%-of-stack commitment threshold", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleInsurancePlayers = new Set(["You"]);
  game.hand.totalContributed.set("You", 100); // well under 50% of 1000
  game.hand.result = { payouts: new Map([["You", 0], [botId, 200]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 0, "too small a commitment to qualify for Insurance");
});

test("_applyRumblePayoutAdjustments gives a 25% bonus for a Bounty-Hunter-flagged winner", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleBountyPlayers = new Set(["You"]);
  game.hand.totalContributed.set("You", 200);
  game.hand.result = { payouts: new Map([["You", 400], [botId, 0]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 500, "400 payout plus a 25% (100) bonus");
});

test("_applyRumblePayoutAdjustments gives no Bounty Hunter bonus on a loss (payout not exceeding contributed)", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleBountyPlayers = new Set(["You"]);
  game.hand.totalContributed.set("You", 200);
  game.hand.result = { payouts: new Map([["You", 0], [botId, 400]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 0);
});

test("_applyRumblePayoutAdjustments is a no-op outside rumble mode", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleInsurancePlayers = new Set(["You"]);
  game.hand.totalContributed.set("You", 600);
  game.hand.result = { payouts: new Map([["You", 0], [botId, 1200]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 0, "no adjustment should happen outside rumble mode");
});

test("_applyRumblePayoutAdjustments fully refunds a Deadman's-Fold-flagged player who actually folded", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleDeadmansFoldPlayers = new Set(["You"]);
  game.hand.folded.add("You");
  game.hand.totalContributed.set("You", 250);
  game.hand.result = { payouts: new Map([["You", 0], [botId, 500]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 250, "a full refund of everything contributed, not partial like Insurance");
});

test("_applyRumblePayoutAdjustments does not refund a Deadman's-Fold-flagged player who never actually folded", () => {
  const game = makeRumbleGame();
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.hand._rumbleDeadmansFoldPlayers = new Set(["You"]);
  // Note: "You" is NOT in game.hand.folded - e.g. they activated it but went to showdown instead.
  game.hand.totalContributed.set("You", 250);
  game.hand.result = { payouts: new Map([["You", 0], [botId, 500]]), pots: [], showdown: null };

  game._applyRumblePayoutAdjustments();
  assert.equal(game.hand.result.payouts.get("You"), 0, "no refund without an actual fold");
});

// ===== Tournament mode =====

function makeTournamentGame(extra = {}) {
  const game = new TableGame({
    numPlayers: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20,
    difficulty: "easy", ...extra,
  });
  game.gameStarted = true;
  game.dealerIndex = 1; // bot is dealer/SB, acts first preflop - "You" is BB
  return game;
}

// Plays a hand where the bot folds the instant it's ever its turn - fold is
// unconditionally legal outside a freeze (see bettingRound.js), so this
// deterministically ends the hand with "You" winning, with zero dependence
// on actual card values (no fixed-deck machinery needed).
function playTournamentHandForcedWin(game) {
  game.startNewHand();
  cancelPendingBotTimer(game);
  const botId = game.players.find((p) => p.type === "bot").id;
  let guard = 0;
  while (!game.hand.complete && guard++ < 20) {
    const actingId = game.hand.actingPlayerId();
    if (actingId === botId) {
      game.hand.applyAction(botId, "fold");
      if (game.hand.complete) game.handleHandComplete();
    } else {
      const legal = game.hand.legalActions("You");
      game.applyPlayerAction("You", legal.check ? "check" : "call");
    }
    cancelPendingBotTimer(game);
  }
}

test("setTournamentMode sets runId/roundNumber and resets the round's hand counter; cancelTournamentMode clears everything", () => {
  const game = makeTournamentGame();
  game.tournamentHandsPlayed = 7; // simulate mid-round
  game.setTournamentMode(true, { runId: 42, roundNumber: 3 });
  assert.equal(game.tournamentMode, true);
  assert.equal(game.tournamentRunId, 42);
  assert.equal(game.tournamentRoundNumber, 3);
  assert.equal(game.tournamentHandsPlayed, 0, "activating a round always resets its own hand counter");

  game.tournamentHandsPlayed = 4;
  game.cancelTournamentMode();
  assert.equal(game.tournamentMode, false);
  assert.equal(game.tournamentRunId, null);
  assert.equal(game.tournamentRoundNumber, 0);
  assert.equal(game.tournamentHandsPlayed, 0);
});

test("updateSettings resets tournament state back to a clean slate for the next game", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 7, roundNumber: 1 });
  game.updateSettings({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.tournamentMode, false);
  assert.equal(game.tournamentRunId, null);
  assert.equal(game.tournamentRoundNumber, 0);
  assert.equal(game.tournamentHandsPlayed, 0);
});

test("getState()/getStateFor() expose tournamentMode/round/hands fields, mirroring rumble's own exposed fields", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 7, roundNumber: 2 });
  game.startNewHand();
  const state = game.getStateFor("You");
  assert.equal(state.tournamentMode, true);
  assert.equal(state.tournamentRoundNumber, 2);
  assert.equal(state.tournamentRoundsTotal, TOURNAMENT_ROUNDS_TOTAL);
  assert.equal(state.tournamentHandsPlayed, 0);
  assert.equal(state.tournamentHandsTotal, TOURNAMENT_ROUND_HANDS_TOTAL);
});

test("tournament hands never emit coinsEarned, even for a logged-in human - same treatment Rumble already gets", () => {
  const game = makeTournamentGame();
  game.setHumanUserId(99);
  game.setTournamentMode(true, { runId: 1, roundNumber: 1 });
  const coinsEvents = [];
  game.on("coinsEarned", (payload) => coinsEvents.push(payload));
  playTournamentHandForcedWin(game);
  assert.equal(coinsEvents.length, 0);
});

test("tournamentRoundComplete does not fire before the round's TOURNAMENT_ROUND_HANDS_TOTAL-th hand", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 1, roundNumber: 1 });
  let fired = false;
  game.on("tournamentRoundComplete", () => { fired = true; });
  for (let i = 0; i < TOURNAMENT_ROUND_HANDS_TOTAL - 1; i++) {
    playTournamentHandForcedWin(game);
    assert.equal(fired, false, `should not fire after hand ${i + 1}`);
  }
});

test("startNewHand refuses to deal an 11th hand into an already-completed tournament round", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 1, roundNumber: 1 });
  for (let i = 0; i < TOURNAMENT_ROUND_HANDS_TOTAL; i++) playTournamentHandForcedWin(game);
  const handCountAfterRound = game.handCount;

  game.startNewHand(); // should be a no-op, e.g. a stray "Next Hand" click racing the round-result modal
  assert.equal(game.handCount, handCountAfterRound, "no 11th hand should have been dealt into the completed round");
});

test("tournamentRoundComplete fires on the round's final hand with the correct runId/roundNumber and a sorted standings array", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 55, roundNumber: 4 });
  let payload = null;
  game.on("tournamentRoundComplete", (p) => { payload = p; });
  for (let i = 0; i < TOURNAMENT_ROUND_HANDS_TOTAL; i++) playTournamentHandForcedWin(game);

  assert.ok(payload, "expected a tournamentRoundComplete event on the final hand");
  assert.equal(payload.runId, 55);
  assert.equal(payload.roundNumber, 4);
  assert.ok(Array.isArray(payload.standings) && payload.standings.length === 2);
  for (let i = 1; i < payload.standings.length; i++) {
    assert.ok(payload.standings[i - 1].stack >= payload.standings[i].stack, "standings should be sorted highest-to-lowest");
  }
});

// Direct state manipulation (same technique the _applyRumblePayoutAdjustments
// tests above use) rather than trying to force an exact numeric outcome
// through real random-deck play - forcing a genuine tie through real hands
// would need deck injection TableGame doesn't expose, and directly setting
// player.stack + a zero-payout hand.result is both simpler and exact.
test("a strict top-stack win: 'You' with the strict highest stack after the round's hands is reported as won, not tied", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 42, roundNumber: 2 });
  game.tournamentHandsPlayed = TOURNAMENT_ROUND_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 900;
  game.players.find((p) => p.id === botId).stack = 100;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  let payload = null;
  game.on("tournamentRoundComplete", (p) => { payload = p; });
  game.handleHandComplete();

  assert.ok(payload);
  assert.equal(payload.won, true);
  assert.equal(payload.tied, false);
});

test("a strict top-stack loss: 'You' below the top stack is reported as not won", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 42, roundNumber: 2 });
  game.tournamentHandsPlayed = TOURNAMENT_ROUND_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 100;
  game.players.find((p) => p.id === botId).stack = 900;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  let payload = null;
  game.on("tournamentRoundComplete", (p) => { payload = p; });
  game.handleHandComplete();

  assert.ok(payload);
  assert.equal(payload.won, false);
  assert.equal(payload.tied, false);
});

test("an exact tie for the top stack is reported as NOT won and tied:true - unlike Rumble's co-winner stance, real coins are staked here", () => {
  const game = makeTournamentGame();
  game.setTournamentMode(true, { runId: 42, roundNumber: 3 });
  game.tournamentHandsPlayed = TOURNAMENT_ROUND_HANDS_TOTAL - 1;
  game.startNewHand();
  const botId = game.players.find((p) => p.type === "bot").id;
  game.players.find((p) => p.id === "You").stack = 500;
  game.players.find((p) => p.id === botId).stack = 500;
  game.hand.result = { payouts: new Map([["You", 0], [botId, 0]]), pots: [], showdown: null };

  let payload = null;
  game.on("tournamentRoundComplete", (p) => { payload = p; });
  game.handleHandComplete();

  assert.ok(payload);
  assert.equal(payload.won, false, "an exact tie must not count as a win");
  assert.equal(payload.tied, true);
});
