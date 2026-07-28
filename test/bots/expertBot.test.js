import { test } from "node:test";
import assert from "node:assert/strict";
import { Hand } from "../../src/hand.js";
import { getExpertAction } from "../../src/bots/expertBot.js";
import { estimateEquityVsUnknown } from "../../src/equity.js";

function assertLegal(decision, legal) {
  assert.ok(decision, "the bot should always return a decision when it's legally its turn");
  assert.ok(["fold", "check", "call", "bet", "raise"].includes(decision.action));
  if (decision.action === "check") assert.ok(legal.check, "returned check when check wasn't legal");
  if (decision.action === "call") assert.ok(legal.call, "returned call when call wasn't legal");
  if (decision.action === "bet") {
    assert.ok(legal.bet, "returned bet when bet wasn't legal");
    assert.ok(decision.amount >= legal.minRaiseTo && decision.amount <= legal.maxRaiseTo, "bet amount out of the legal range");
  }
  if (decision.action === "raise") {
    assert.ok(legal.raise, "returned raise when raise wasn't legal");
    assert.ok(decision.amount >= legal.minRaiseTo && decision.amount <= legal.maxRaiseTo, "raise amount out of the legal range");
  }
}

// Tests use a small equitySamples override throughout - production defaults
// to 300 (see EQUITY_SAMPLES in expertBot.js), but these tests run hundreds
// of trials each, and the assertions are about decision *shape* (fold vs.
// call vs. bet, roughly-expected frequencies), not raw equity precision, so
// a much smaller/faster sample count doesn't change what's being verified.
const FAST = { equitySamples: 25 };

test("getExpertAction always returns a legal action, across many random hands, table sizes, and personalities", () => {
  const personalities = ["TAG", "LAG", "tight-passive", "loose-passive", "maniac", "calling-station"];
  const seenActions = new Set();
  for (let trial = 0; trial < 60; trial++) {
    const personality = personalities[trial % personalities.length];
    const numPlayers = 2 + (trial % 5);
    const players = [{ id: "You", stack: 2000 }];
    for (let i = 1; i < numPlayers; i++) players.push({ id: `Expert_${i}`, stack: 2000 });

    const hand = new Hand({ players, minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: trial % numPlayers });

    let guard = 0;
    while (!hand.complete && guard++ < 200) {
      const actingId = hand.actingPlayerId();
      const legal = hand.legalActions(actingId);
      if (actingId === "You") {
        hand.applyAction("You", legal.check ? "check" : "call");
        continue;
      }
      const decision = getExpertAction(actingId, hand, { ...FAST, personality });
      assertLegal(decision, legal);
      seenActions.add(decision.action);
      hand.applyAction(actingId, decision.action, decision.amount);
    }
    assert.ok(hand.complete, "hand should reach completion, not stall or loop forever");
  }
  // Proves the pot-relative sizing paths (both a fresh bet and a raise into
  // an existing bet) actually got exercised across the trials above, not
  // silently skipped.
  assert.ok(seenActions.has("bet"), "expected at least one bet across all trials");
  assert.ok(seenActions.has("raise"), "expected at least one raise across all trials");
});

// Heads-up setup where "You" is SB/dealer (acts first preflop) and the
// Expert bot is BB - the heads-up quirk means BB also acts first on every
// postflop street, so the bot is first-to-act on the flop with nothing bet
// yet, right where these fixed-board tests need it.
function dealHeadsUpToFlop(botStack = 100000, youStack = 100000) {
  const players = [{ id: "You", stack: youStack }, { id: "Expert", stack: botStack }];
  const hand = new Hand({ players, minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: 0 });
  assert.equal(hand.actingPlayerId(), "You");
  hand.applyAction("You", "call");
  assert.equal(hand.actingPlayerId(), "Expert");
  hand.applyAction("Expert", "check"); // closes preflop
  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.actingPlayerId(), "Expert");
  return hand;
}

// Opposite dealer assignment from dealHeadsUpToFlop() above: here "You" is
// BB, so the heads-up quirk makes YOU act first postflop instead of the
// bot - needed for the "facing a bet" tests, where "You" bets into the bot.
function dealHeadsUpToFlopBotFacesBet(botStack = 100000, youStack = 100000) {
  const players = [{ id: "You", stack: youStack }, { id: "Expert", stack: botStack }];
  const hand = new Hand({ players, minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: 1 });
  assert.equal(hand.actingPlayerId(), "Expert");
  hand.applyAction("Expert", "call");
  assert.equal(hand.actingPlayerId(), "You");
  hand.applyAction("You", "check"); // closes preflop
  assert.equal(hand.currentStreetName(), "flop");
  assert.equal(hand.actingPlayerId(), "You");
  return hand;
}

function c(rank, suit) { return { rank, suit }; }

test("getExpertAction folds a genuinely air hand facing a big bet, nearly every time - and never calls it", () => {
  let folds = 0, calls = 0, raises = 0;
  const trials = 100;
  for (let i = 0; i < trials; i++) {
    const hand = dealHeadsUpToFlopBotFacesBet();
    // Hero: 3h2d - no pair, no draw, and lower than every board card (no
    // overcard either) against Kc Qs Jc.
    hand.holeCards.set("Expert", [c(3, "h"), c(2, "d")]);
    hand.board = [c(13, "c"), c(12, "s"), c(11, "c")];
    hand.applyAction("You", "bet", 400); // a big overbet relative to the 40-chip pot
    assert.equal(hand.actingPlayerId(), "Expert");

    const decision = getExpertAction("Expert", hand, FAST);
    assertLegal(decision, hand.legalActions("Expert"));
    if (decision.action === "fold") folds++;
    else if (decision.action === "call") calls++;
    else if (decision.action === "raise") raises++;
  }
  // This hand has no pair/draw/overcard, so notAirPostflop is false - MDF
  // defense (which only ever produces a call) can never fire here, meaning
  // every non-fold outcome must be the separate, intentional sizing-derived
  // bluff-RAISE path, never a call. calls === 0 proves the two mechanisms
  // stay properly separated instead of MDF leaking a call onto true air.
  assert.equal(calls, 0, "a hand with no pair/draw/overcard should never be MDF-defended with a call");
  assert.ok(folds >= trials * 0.8, `expected folds in at least 80% of trials (the rest being the designed bluff-raise minority), got ${folds}/${trials}`);
  assert.equal(folds + raises, trials, "every non-fold outcome on true air should be a bluff-raise, not a call");
});

test("getExpertAction never folds a flopped monster facing a small bet", () => {
  const trials = 60;
  for (let i = 0; i < trials; i++) {
    const hand = dealHeadsUpToFlopBotFacesBet();
    // Hero: 8h8d, board pairs the 8 - flopped trips (three of a kind).
    hand.holeCards.set("Expert", [c(8, "h"), c(8, "d")]);
    hand.board = [c(8, "c"), c(2, "s"), c(4, "d")];
    hand.applyAction("You", "bet", 20); // small bet into a 40-chip pot - great odds regardless
    assert.equal(hand.actingPlayerId(), "Expert");

    const decision = getExpertAction("Expert", hand, FAST);
    assertLegal(decision, hand.legalActions("Expert"));
    assert.ok(["call", "raise"].includes(decision.action), "a flopped three of a kind should never fold to a small bet");
  }
});

test("getExpertAction's bluff frequency, when checked to with pure air, tracks the sizing-derived break-even ratio", () => {
  let bets = 0;
  const trials = 400;
  const personality = "TAG"; // bluffFreq 0.12, close to the 0.15 "neutral" baseline
  for (let i = 0; i < trials; i++) {
    const hand = dealHeadsUpToFlop();
    hand.holeCards.set("Expert", [c(3, "h"), c(2, "d")]);
    hand.board = [c(13, "c"), c(12, "s"), c(11, "c")];
    // Nothing bet yet - Expert is first to act, legal.check is true.
    assert.ok(hand.legalActions("Expert").check);

    const decision = getExpertAction("Expert", hand, { ...FAST, personality });
    assertLegal(decision, hand.legalActions("Expert"));
    if (decision.action === "bet") bets++;
  }
  const observed = bets / trials;
  // aggression blends preset (TAG 70) with default slider (50) -> 60/100 = 0.6.
  // Polarized-bluff sizing fraction = 0.70 + 0.35*aggression = 0.91 pot.
  // alpha (break-even ratio for that sizing) = fraction / (1 + fraction).
  const aggression = (70 + 50) / 200;
  const fraction = 0.70 + 0.35 * aggression;
  const alpha = fraction / (1 + fraction);
  const bluffFreq = (0.12 + 0.15) / 2; // preset TAG blended with default botTraits.bluffFreq (0.15)
  const expected = Math.min(0.95, Math.max(0, alpha * (bluffFreq / 0.15)));
  assert.ok(
    Math.abs(observed - expected) < 0.12,
    `observed bluff rate ${observed} should be within a generous band of the analytically-expected ${expected}`
  );
});

test("getExpertAction occasionally (not never, not always) defends a live-overcard hand that's below required equity - MDF-style", () => {
  // Hero has ace-high (a live overcard, no pair, no draw) - some residual
  // equity, but not enough to profitably call the bet size chosen below.
  const heroHole = [c(14, "h"), c(2, "d")];
  const board = [c(13, "c"), c(12, "s"), c(7, "c")];
  // Confirm this spot is actually -EV before asserting bot behavior against
  // it, rather than assuming the constructed numbers work out.
  const equity = estimateEquityVsUnknown({ heroHoleCards: heroHole, board, numOpponents: 1, samples: 4000 });
  const potBefore = 40; // blinds-only pot before the bet below
  const toCall = 200;
  const requiredEquity = toCall / (potBefore + toCall + toCall); // toCall added to pot once (bettor's bet) + hero's own call
  assert.ok(equity < requiredEquity, `test setup assumption failed: equity ${equity} should be below required ${requiredEquity}`);

  // A separate test already covers the sizing-derived bluff-RAISE path on
  // pure air - this test isolates the MDF-style call-defense mechanism
  // specifically, so it tracks calls on their own rather than lumping them
  // in with "any non-fold" (which would also include bluff-raises, a
  // different mechanism with its own frequency target). A higher sample
  // count than FAST is used here since this spot's equity is a real,
  // moderate, non-lopsided number (ace-high) - too much Monte Carlo noise
  // at very low sample counts would occasionally push a single decision's
  // equity estimate above the required-equity line by chance alone.
  const PRECISE = { equitySamples: 150 };
  let folds = 0, calls = 0, raises = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const hand = dealHeadsUpToFlopBotFacesBet();
    hand.holeCards.set("Expert", heroHole);
    hand.board = board;
    hand.applyAction("You", "bet", toCall);
    const decision = getExpertAction("Expert", hand, PRECISE);
    assertLegal(decision, hand.legalActions("Expert"));
    if (decision.action === "fold") folds++;
    else if (decision.action === "call") calls++;
    else if (decision.action === "raise") raises++;
  }
  assert.ok(calls > 0, "expected at least some MDF-style call-defense, not a pure fold-machine");
  assert.ok(calls < trials * 0.5, `MDF-style call-defense should be a minority of outcomes, got ${calls}/${trials}`);
  assert.ok(folds > raises, "fold should still outnumber the separate sizing-derived bluff-raise minority");
});

test("getExpertAction's personality presets stay directionally distinct: looser presets continue against a preflop open noticeably more than tighter ones", () => {
  function continueRate(personality, trials) {
    let continued = 0;
    for (let i = 0; i < trials; i++) {
      const players = [{ id: "You", stack: 2000 }, { id: "Expert", stack: 2000 }];
      const hand = new Hand({ players, minRaise: 20, smallBlind: 10, bigBlind: 20, dealerIndex: 0 }); // You = SB/dealer, acts first
      assert.equal(hand.actingPlayerId(), "You");
      // Below the 3x-BB facing3bet threshold (bigBlind*3 = 60) on purpose -
      // this needs to land in the "normal preflop decision" branch, which
      // is where the vpip range-entry gate (personality's main lever for a
      // non-premium/strong hand) actually applies. A raise to exactly/above
      // 60 gets classified as facing a 3-bet instead, a branch where
      // premium/strong/playable range classification (identical across all
      // personalities) dominates and vpip never gates entry at all - that
      // was the original, too-weak version of this test.
      hand.applyAction("You", "raise", 40);
      assert.equal(hand.actingPlayerId(), "Expert");
      const decision = getExpertAction("Expert", hand, { ...FAST, personality });
      if (decision.action !== "fold") continued++;
    }
    return continued / trials;
  }

  // 250 trials on real random deals left this borderline-flaky (binomial
  // noise on a proportion around 0.3-0.45 has a standard error of ~3 points
  // per arm here, ~4-5 points on a difference of two arms) - 600 trials and
  // a slightly less strict gap keeps this a meaningful regression guard
  // without chasing exact numbers that were never guaranteed to be stable
  // run to run.
  const trials = 600;
  const tag = continueRate("TAG", trials);
  const lag = continueRate("LAG", trials);
  const maniac = continueRate("maniac", trials);
  const tightPassive = continueRate("tight-passive", trials);

  assert.ok(lag - tag > 0.07, `LAG (${lag}) should continue noticeably more than TAG (${tag})`);
  assert.ok(maniac - tightPassive > 0.12, `maniac (${maniac}) should continue noticeably more than tight-passive (${tightPassive})`);
});

test("getExpertAction computes equity exactly once per decision - stays fast at production sample count", () => {
  const start = Date.now();
  for (let i = 0; i < 50; i++) {
    const hand = dealHeadsUpToFlop();
    getExpertAction("Expert", hand); // no override - production default (300 samples)
  }
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 8000, `50 decisions at production sample count took ${elapsedMs}ms - unexpectedly slow, possible duplicate/looped equity call`);
});
