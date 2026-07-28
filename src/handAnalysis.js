import { describeScore, bestHand } from "./handEvaluator.js";
import { computeAllInEquity, estimateEquityVsUnknown } from "./equity.js";
import { STREETS_ORDER } from "./tableGame.js";

const TIER_LABEL = {
  brilliant: "Brilliant",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

// Grades a single decision "You" made, given your equity at the time and
// what you were actually facing (the pot before acting, and the amount
// needed to call, both captured live by TableGame at the moment of the
// decision). This stays directionally reasonable rather than solver-exact,
// the same standard the Range Trainer's own Chen Formula heuristic holds
// itself to - a true solver would need full opponent range modeling this
// app doesn't attempt.
//
// Fold/call decisions are graded against the actual pot odds faced: calling
// is worth it when your equity clears the price you're being asked to pay,
// and folding is worth it when it doesn't. Bet/raise decisions have no
// opponent range to weigh against, so they're graded on hand strength alone
// instead - a bet with a strong hand reads as sound, a bet with a weak one
// reads as shaky, regardless of whether it happened to work.
//
// Raw win-probability against N live opponents necessarily shrinks as N
// grows (even pocket aces is only a ~49% favorite against 5 live opponents)
// - grading bet/raise on raw equity against a fixed absolute bar would
// unfairly punish multiway pots, and hit hardest on the very first action of
// a hand, when the most opponents are still live. Instead this compares
// equity against "fair share" for the number of live opponents
// (1 / (numOpponents + 1), what an average random hand would run) and grades
// on how far above or below that baseline the hand's equity falls, scaled so
// the result stays comparable whether it's a heads-up pot or a 6-way one.
function gradeDecision({ action, equity, potBefore, toCall, numOpponents }) {
  if (typeof equity !== "number" || typeof potBefore !== "number" || typeof toCall !== "number") return null;

  if (action === "check") return { tier: "good", label: TIER_LABEL.good };

  if (action === "fold" || action === "call") {
    if (toCall <= 0) return { tier: "good", label: TIER_LABEL.good };
    const potAfterCall = potBefore + toCall;
    const requiredEquity = toCall / potAfterCall;
    const evCall = equity * potAfterCall - toCall; // vs. a fold's baseline of 0
    const evGapPct = Math.abs(evCall) / potAfterCall; // scale-independent, for tier thresholds

    const correct = action === "call" ? evCall >= 0 : evCall <= 0;
    const closeDecision = Math.abs(equity - requiredEquity) < 0.08;

    if (correct) {
      return closeDecision ? { tier: "brilliant", label: TIER_LABEL.brilliant } : { tier: "good", label: TIER_LABEL.good };
    }
    if (evGapPct < 0.05) return { tier: "inaccuracy", label: TIER_LABEL.inaccuracy };
    if (evGapPct < 0.12) return { tier: "mistake", label: TIER_LABEL.mistake };
    return { tier: "blunder", label: TIER_LABEL.blunder };
  }

  if (action === "bet" || action === "raise") {
    const liveOpponents = typeof numOpponents === "number" && numOpponents > 0 ? numOpponents : 1;
    const fairShare = 1 / (liveOpponents + 1);
    // How much of the equity "headroom" above fair share got captured, as a
    // fraction of the maximum possible headroom (1 - fairShare) - this stays
    // in roughly the same range regardless of how many opponents are live,
    // unlike raw equity itself.
    const excessRatio = (equity - fairShare) / (1 - fairShare);
    if (excessRatio >= 0.45) return { tier: "brilliant", label: TIER_LABEL.brilliant };
    if (excessRatio >= 0.10) return { tier: "good", label: TIER_LABEL.good };
    if (excessRatio >= -0.05) return { tier: "inaccuracy", label: TIER_LABEL.inaccuracy };
    if (excessRatio >= -0.20) return { tier: "mistake", label: TIER_LABEL.mistake };
    return { tier: "blunder", label: TIER_LABEL.blunder };
  }

  return null;
}

// Builds the payload for the hand replayer/analyzer: "You"'s hole cards, a
// best-hand description, and one entry per street with that street's board,
// the actions taken on it (graded, for "You"'s own decisions), and "You"'s
// equity at that point.
//
// Equity is computed two different ways depending on what's knowable:
//   - Exact (via computeAllInEquity): for streets at/after a real all-in
//     "You" were part of - hole cards are effectively revealed at that point,
//     so exact/Monte Carlo enumeration against the KNOWN opponent hands is
//     both possible and strictly more accurate.
//   - Estimated (via estimateEquityVsUnknown): everywhere else - opponents'
//     hole cards are genuinely unknown, so this is a Monte Carlo estimate
//     against however many opponents were still live at that street.
// No equity is computed for streets after "You" folded (nothing to compute -
// "You" were no longer eligible to win).
function buildHandAnalysis(tableGame) {
  const hand = tableGame.hand;
  if (!hand || !hand.complete) return null;

  const heroHoleCards = hand.holeCards.get("You") || [];
  let yourBestHandDescription = "";
  if (heroHoleCards.length === 2 && hand.board.length >= 3) {
    try {
      const best = bestHand([...heroHoleCards, ...hand.board]);
      yourBestHandDescription = describeScore(best.score);
    } catch (e) {}
  }

  const allInSnap = hand.allInSnapshot;
  const allInCoversYou = !!(allInSnap && allInSnap.participants.some((p) => p.id === "You"));

  const youFoldAction = tableGame.currentHandActions.find((a) => a.actor === "You" && a.action === "fold");
  const youFoldStreetIdx = youFoldAction ? STREETS_ORDER.indexOf(youFoldAction.street) : Infinity;

  const yourGradedTiers = [];

  const streetSnapshots = tableGame.streetSnapshots.map((snap) => {
    const streetIdx = STREETS_ORDER.indexOf(snap.street);

    const foldedBefore = new Set(
      tableGame.currentHandActions
        .filter((a) => a.action === "fold" && STREETS_ORDER.indexOf(a.street) < streetIdx)
        .map((a) => a.actor)
    );
    const numOpponents = hand.order.filter((id) => id !== "You" && !foldedBefore.has(id)).length;

    let equityAtStreet = null;
    let equityIsExact = false;
    if (heroHoleCards.length === 2 && streetIdx <= youFoldStreetIdx) {
      if (allInCoversYou && snap.board.length >= allInSnap.boardAtAllIn.length) {
        const equity = computeAllInEquity({ participants: allInSnap.participants, boardAtAllIn: snap.board });
        equityAtStreet = equity["You"] ?? null;
        equityIsExact = true;
      } else {
        equityAtStreet = estimateEquityVsUnknown({ heroHoleCards, board: snap.board, numOpponents });
        equityIsExact = false;
      }
    }

    const actions = tableGame.currentHandActions
      .filter((a) => a.street === snap.street)
      .map((a) => {
        if (a.actor !== "You") return a;
        const grade = gradeDecision({ action: a.action, equity: equityAtStreet, potBefore: a.potBefore, toCall: a.toCall, numOpponents });
        if (grade) yourGradedTiers.push(grade.tier);
        return { ...a, grade };
      });

    return {
      street: snap.street,
      board: snap.board,
      potAtStreetStart: snap.potAtStreetStart,
      actions,
      equityAtStreet,
      equityIsExact,
    };
  });

  // Separate from decision grading above: did the RESULT match the quality
  // of the decisions, or not? Good decisions can still lose to a bad
  // runout, and bad decisions can still back into a win - calling that out
  // explicitly keeps the grading from reading as "you lost, so you played
  // badly," which isn't always true. Folded hands are excluded - folding
  // ends your interest in the outcome on purpose, so there's no "luck" left
  // to speak of.
  const youFolded = youFoldStreetIdx !== Infinity;
  const youWon = hand.result ? (hand.result.payouts.get("You") || 0) > 0 : false;
  const hadMistakeOrBlunder = yourGradedTiers.some((t) => t === "mistake" || t === "blunder");
  let luckTag = null;
  let luckLabel = "";
  if (!youFolded && hand.result) {
    if (!hadMistakeOrBlunder && !youWon) {
      luckTag = "unlucky";
      luckLabel = "Unlucky: your decisions were sound, the result just didn't go your way.";
    } else if (hadMistakeOrBlunder && youWon) {
      luckTag = "lucky";
      luckLabel = "Lucky: some of your decisions were shaky, but you won anyway.";
    }
  }

  return {
    handCount: tableGame.handCount,
    board: hand.board,
    holeCards: heroHoleCards,
    yourBestHandDescription,
    totalContributed: Object.fromEntries(hand.totalContributed),
    order: hand.order,
    pots: hand.result ? hand.result.pots : [],
    stacks: Object.fromEntries(hand.stacks),
    payouts: hand.result ? Object.fromEntries(hand.result.payouts) : {},
    streetSnapshots,
    luckTag,
    luckLabel,
  };
}

export { buildHandAnalysis, gradeDecision };
