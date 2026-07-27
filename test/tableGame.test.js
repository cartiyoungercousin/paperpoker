import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame } from "../server.js";
import { xpForHand } from "../src/rankTiers.js";
import { RANKED_FIXED_SETTINGS } from "../src/rankedConfig.js";
import { HEADS_UP_ONLY_DIFFICULTIES, BOARDROOM_CHARACTERS } from "../src/tableGame.js";

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
  // XP is pot-scaled (see rankTiers.test.js for the formula itself) - compute
  // the same way TableGame does rather than assuming the flat base amount.
  const potSize = game.hand.result.pots.reduce((s, pot) => s + pot.amount, 0);
  const expectedDelta = xpForHand("medium", expectedWin, potSize, game.startingStack);
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

test("a ranked hand emits both 'coinsEarned' and 'xpEarned' - they're independent, not mutually exclusive", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.setHumanUserId(7);
  game.setRankedMode(true, 7);

  let coinsEventFired = false;
  let xpEventFired = false;
  game.on("coinsEarned", () => { coinsEventFired = true; });
  game.on("xpEarned", () => { xpEventFired = true; });

  playHeadsUpCheckdown(game);

  assert.equal(coinsEventFired, true);
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
