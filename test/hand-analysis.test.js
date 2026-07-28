import { test } from "node:test";
import assert from "node:assert/strict";
import { TableGame, buildHandAnalysis } from "../server.js";
import { gradeDecision } from "../src/handAnalysis.js";
import { Hand } from "../src/hand.js";

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

  // Heads-up, the big blind (bot) acts first every street after preflop.
  for (let street = 0; street < 3 && !game.hand.complete; street++) {
    applyOpponentAction(game, bot, "check");
    if (!game.hand.complete) {
      assert.ok(game.applyPlayerAction("You", "check"));
      cancelPendingBotTimer(game);
    }
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
  // Heads-up, the big blind (bot) acts first on the flop - "You" fold once
  // it's actually your turn.
  applyOpponentAction(game, bot, "check");
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

// ===== gradeDecision (chess.com-style tiered decision grading) =====

test("gradeDecision: folding with equity clearly below the pot odds needed grades as Good", () => {
  // Facing a pot-sized call (50/50 required equity) with only 10% equity -
  // folding is clearly correct, and not a close call, so it's just Good.
  const grade = gradeDecision({ action: "fold", equity: 0.10, potBefore: 100, toCall: 100 });
  assert.equal(grade.tier, "good");
});

test("gradeDecision: a comfortably correct call (not a close decision) grades as Good, not Brilliant", () => {
  const grade = gradeDecision({ action: "call", equity: 0.9, potBefore: 100, toCall: 50 });
  assert.equal(grade.tier, "good");
});

test("gradeDecision: a correct call that was genuinely close grades as Brilliant", () => {
  // Required equity here is 50/150 = 33.3% - 36% clears it, but only barely.
  const grade = gradeDecision({ action: "call", equity: 0.36, potBefore: 100, toCall: 50 });
  assert.equal(grade.tier, "brilliant");
});

test("gradeDecision: a clearly bad call (large equity shortfall) grades as a Blunder", () => {
  // Required equity is 50%, actual equity is 5% - a very bad call.
  const grade = gradeDecision({ action: "call", equity: 0.05, potBefore: 100, toCall: 100 });
  assert.equal(grade.tier, "blunder");
});

test("gradeDecision: a mildly bad call (small equity shortfall) grades as an Inaccuracy, not a Blunder", () => {
  // Required equity is 50%, actual equity is 47% - technically wrong, but barely.
  const grade = gradeDecision({ action: "call", equity: 0.47, potBefore: 100, toCall: 100 });
  assert.equal(grade.tier, "inaccuracy");
});

test("gradeDecision: bet/raise tiers scale with hand strength relative to a fair-share baseline (heads-up: fair share = 50% equity)", () => {
  assert.equal(gradeDecision({ action: "bet", equity: 0.30, potBefore: 50, toCall: 0, numOpponents: 1 }).tier, "blunder");
  assert.equal(gradeDecision({ action: "bet", equity: 0.45, potBefore: 50, toCall: 0, numOpponents: 1 }).tier, "mistake");
  assert.equal(gradeDecision({ action: "raise", equity: 0.50, potBefore: 50, toCall: 20, numOpponents: 1 }).tier, "inaccuracy");
  assert.equal(gradeDecision({ action: "raise", equity: 0.60, potBefore: 50, toCall: 20, numOpponents: 1 }).tier, "good");
  assert.equal(gradeDecision({ action: "bet", equity: 0.85, potBefore: 50, toCall: 0, numOpponents: 1 }).tier, "brilliant");
});

test("gradeDecision: bet/raise grading adjusts for how many opponents are live, so a crowded pot's lower raw equity isn't automatically punished", () => {
  // The exact same ~49% equity is a losing spot heads-up (fair share is 50%
  // there) but a monster edge against 5 live opponents (fair share there is
  // only ~16.7%, since pocket aces itself is only about a 49% favorite in a
  // full 6-max pot) - the grade should reflect that, not treat raw equity as
  // an absolute, opponent-count-independent bar.
  const headsUp = gradeDecision({ action: "raise", equity: 0.49, potBefore: 50, toCall: 0, numOpponents: 1 });
  const sixMax = gradeDecision({ action: "raise", equity: 0.49, potBefore: 50, toCall: 0, numOpponents: 5 });
  assert.equal(headsUp.tier, "inaccuracy");
  assert.ok(["good", "brilliant"].includes(sixMax.tier), "the same raw equity against 5 live opponents is a huge relative edge, not a shaky raise");
});

test("gradeDecision: raising the worst possible hand still grades poorly in a multiway pot, not falsely rescued by the opponent-count adjustment", () => {
  // ~8% equity 5-way is roughly what the worst possible starting hand runs -
  // clearly below even its adjusted ~16.7% fair share.
  const grade = gradeDecision({ action: "raise", equity: 0.08, potBefore: 50, toCall: 0, numOpponents: 5 });
  assert.ok(["mistake", "blunder"].includes(grade.tier));
});

test("gradeDecision: checking is always graded Good - there's no price to get wrong when the action is free", () => {
  const grade = gradeDecision({ action: "check", equity: 0.02, potBefore: 100, toCall: 0 });
  assert.equal(grade.tier, "good");
});

test("gradeDecision: returns null rather than guessing when the inputs needed to grade aren't available", () => {
  assert.equal(gradeDecision({ action: "call", equity: undefined, potBefore: 100, toCall: 50 }), null);
  assert.equal(gradeDecision({ action: "call", equity: 0.5, potBefore: null, toCall: 50 }), null);
});

// ===== buildHandAnalysis wiring: grades attached to "You"'s actions, luck tag =====

function cIdx(rank, suit) { return { rank, suit }; }

function fixedDeck(cardsInDealOrder) {
  return {
    cards: [...cardsInDealOrder],
    draw(n) { return this.cards.splice(0, n); },
  };
}

// Swaps the just-started (randomly dealt) hand for one dealt from a known,
// fixed deck - same technique test/hand.test.js uses for the Hand class
// directly, applied here at the TableGame level so buildHandAnalysis sees a
// deterministic showdown. Reuses the exact player list/stacks TableGame's
// own real deal just produced, so nothing about seating or blinds changes.
function dealFixedHand(game, cardsInDealOrder) {
  game.startNewHand();
  cancelPendingBotTimer(game);
  const players = game.hand.order.map((id) => ({ id, stack: game.hand.stacks.get(id) }));
  game.hand = new Hand({
    players,
    minRaise: game.minRaise,
    smallBlind: game.smallBlind,
    bigBlind: game.bigBlind,
    dealerIndex: game.dealerIndex,
    deck: fixedDeck(cardsInDealOrder),
  });
  game.currentHandActions = [];
  game.streetSnapshots = [{ street: "preflop", board: [], potAtStreetStart: game._potTotal() }];
}

test("buildHandAnalysis: a call action carries the same grade gradeDecision() computes from the equity/potBefore/toCall recorded alongside it", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1; // bot is SB/dealer, acts first preflop; "You" is BB
  const bot = botId(game);

  dealFixedHand(game, [
    cIdx(7, "h"), cIdx(2, "s"), // You
    cIdx(13, "c"), cIdx(11, "d"), // bot
    cIdx(12, "h"), // burn
    cIdx(9, "s"), cIdx(4, "d"), cIdx(3, "c"), // flop - misses "You" entirely
    cIdx(12, "d"), // burn
    cIdx(9, "h"), // turn
    cIdx(12, "c"), // burn
    cIdx(2, "h"), // river
  ]);

  // Preflop: bot (SB) completes to the BB, "You" checks the BB option.
  applyOpponentAction(game, bot, "call");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  assert.equal(game.hand.currentStreetName(), "flop");

  // Flop: "You" (BB) acts first heads-up - checks it over, bot open-bets big
  // relative to the tiny preflop pot, "You" calls anyway despite having
  // missed the board completely with 7h2s.
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  applyOpponentAction(game, bot, "bet", 300);
  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);

  // buildHandAnalysis needs a completed hand - check the rest down. Heads-up,
  // "You" (BB) acts first on turn/river too.
  for (let i = 0; i < 2 && !game.hand.complete; i++) {
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) applyOpponentAction(game, bot, "check");
  }
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  const analysis = buildHandAnalysis(game);
  const flopSnap = analysis.streetSnapshots.find((s) => s.street === "flop");
  const yourCall = flopSnap.actions.find((a) => a.actor === "You" && a.action === "call");
  assert.ok(yourCall, "expected You's flop call to be in the action log");
  assert.equal(typeof yourCall.potBefore, "number");
  assert.equal(typeof yourCall.toCall, "number");

  const expectedGrade = gradeDecision({ action: "call", equity: flopSnap.equityAtStreet, potBefore: yourCall.potBefore, toCall: yourCall.toCall });
  assert.deepEqual(yourCall.grade, expectedGrade, "the grade attached to the action should be exactly what gradeDecision computes from the same recorded inputs");
  // 7-high on a completely unconnected board facing a big overbet is not a
  // close decision - whatever the exact Monte Carlo equity estimate came
  // out to, this should not have graded as a good call.
  assert.ok(["mistake", "blunder"].includes(yourCall.grade.tier));
});

test("buildHandAnalysis: checking down a hand you lose with no bad decisions is tagged unlucky, not a mistake", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1;
  const bot = botId(game);

  dealFixedHand(game, [
    cIdx(2, "h"), cIdx(3, "s"), // You - never improves
    cIdx(14, "c"), cIdx(13, "d"), // bot - flops top two pair
    cIdx(12, "h"), // burn
    cIdx(14, "h"), cIdx(9, "d"), cIdx(4, "c"), // flop
    cIdx(12, "d"), // burn
    cIdx(9, "s"), // turn - bot now has aces and nines
    cIdx(12, "c"), // burn
    cIdx(13, "c"), // river - bot ends with two pair, aces over kings
  ]);

  // Straight check-down, every street, both players - nobody ever faces a
  // real decision, so every one of "You"'s actions should grade Good.
  // Heads-up, "You" (BB) acts first on every street after preflop.
  applyOpponentAction(game, bot, "call");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  for (let i = 0; i < 3 && !game.hand.complete; i++) {
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) applyOpponentAction(game, bot, "check");
  }
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.equal(game.hand.result.payouts.get("You") || 0, 0, "You should have lost this hand outright");

  const analysis = buildHandAnalysis(game);
  const yourGrades = analysis.streetSnapshots.flatMap((s) => s.actions.filter((a) => a.actor === "You" && a.grade)).map((a) => a.grade.tier);
  assert.ok(yourGrades.length > 0);
  assert.ok(yourGrades.every((t) => t === "good" || t === "brilliant"), "every check should have graded Good");
  assert.equal(analysis.luckTag, "unlucky");
});

test("buildHandAnalysis: winning a hand that included a real mistake is tagged lucky, not validated as good play", () => {
  const game = new TableGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.gameStarted = true;
  game.dealerIndex = 1;
  const bot = botId(game);

  dealFixedHand(game, [
    cIdx(7, "h"), cIdx(2, "s"), // You - pairs up on the turn and river
    cIdx(13, "c"), cIdx(11, "d"), // bot - never improves past king-high
    cIdx(12, "h"), // burn
    cIdx(9, "s"), cIdx(4, "d"), cIdx(3, "c"), // flop - misses "You" entirely
    cIdx(12, "d"), // burn
    cIdx(7, "c"), // turn - pairs You's 7
    cIdx(12, "c"), // burn
    cIdx(2, "h"), // river - pairs You's 2 too, two pair for You
  ]);

  applyOpponentAction(game, bot, "call");
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);

  // Flop: "You" (BB) acts first heads-up - checks it over, bot bets big,
  // "You" makes a bad call with 7-high on a dry board.
  assert.ok(game.applyPlayerAction("You", "check"));
  cancelPendingBotTimer(game);
  applyOpponentAction(game, bot, "bet", 300);
  assert.ok(game.applyPlayerAction("You", "call"));
  cancelPendingBotTimer(game);

  // Turn and river: check down, "You" (BB) acts first, rivers two pair and wins.
  for (let i = 0; i < 2 && !game.hand.complete; i++) {
    assert.ok(game.applyPlayerAction("You", "check"));
    cancelPendingBotTimer(game);
    if (!game.hand.complete) applyOpponentAction(game, bot, "check");
  }
  if (game.stats.handsPlayed === 0) game.handleHandComplete();

  assert.ok((game.hand.result.payouts.get("You") || 0) > 0, "You should have won this hand at showdown");

  const analysis = buildHandAnalysis(game);
  const yourGrades = analysis.streetSnapshots.flatMap((s) => s.actions.filter((a) => a.actor === "You" && a.grade)).map((a) => a.grade.tier);
  assert.ok(yourGrades.some((t) => t === "mistake" || t === "blunder"), "the flop call should have graded poorly");
  assert.equal(analysis.luckTag, "lucky");
});
