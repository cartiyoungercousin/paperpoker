/**
 * The Rock (experimental, 1v1 only):
 * - Extremely tight and passive - folds almost everything preflop that
 *   isn't a genuinely strong holding.
 * - Rarely raises even with a real hand, preferring to call and see where
 *   it stands rather than build the pot.
 * - Genuinely alarming the rare time it does come out firing, since it
 *   almost never happens without the real goods behind it.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";

const PREMIUM_RANK_FLOOR = 10; // Jack or higher

function isPreflopPremium(holeCards) {
  const [a, b] = holeCards;
  if (a.rank === b.rank) return a.rank >= 6; // any pair 8s or better
  return a.rank >= PREMIUM_RANK_FLOOR && b.rank >= PREMIUM_RANK_FLOOR;
}

function postflopStrength(playerId, hand) {
  const holeCards = hand.holeCards.get(playerId);
  const board = hand.board;
  const best = bestHand([...holeCards, ...board]);
  return best.score[0];
}

function randomSizedRaise(legal) {
  const span = legal.maxRaiseTo - legal.minRaiseTo;
  return Math.min(legal.maxRaiseTo, legal.minRaiseTo + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0));
}

export function getRockAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const holeCards = hand.holeCards.get(playerId);
  const board = hand.board;
  const strong = board.length > 0
    ? postflopStrength(playerId, hand) >= CATEGORY.TWO_PAIR
    : isPreflopPremium(holeCards);

  if (legal.check) {
    // Even with a strong hand, mostly checks and lets the other player do
    // the betting - only rarely leads out itself. legal.raise covers the
    // big-blind-option case, where the posted blind counts as the bet.
    if (strong && Math.random() < 0.25) {
      if (legal.bet) return { action: "bet", amount: randomSizedRaise(legal) };
      if (legal.raise) return { action: "raise", amount: randomSizedRaise(legal) };
    }
    return { action: "check" };
  }

  if (legal.call || legal.raise) {
    if (!strong) return { action: "fold" };
    if (legal.raise && Math.random() < 0.3) {
      return { action: "raise", amount: randomSizedRaise(legal) };
    }
    return { action: "call" };
  }

  return { action: "fold" };
}
