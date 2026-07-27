/**
 * Drunk Bot Logic (experimental, solo/unranked only):
 * - Decisions are mostly random, only loosely nudged by hand strength.
 * - Occasionally shoves way more than the situation calls for.
 * - Sometimes checks a monster hand instead of betting it, just because -
 *   not a deliberate slow play, just inconsistent.
 * - Folds far less predictably than a sober bot would.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";

function handCategoryOf(playerId, hand) {
  const holeCards = hand.holeCards.get(playerId);
  const board = hand.board;
  if (board.length > 0) {
    const best = bestHand([...holeCards, ...board]);
    return best.score[0];
  }
  return holeCards[0].rank === holeCards[1].rank ? CATEGORY.ONE_PAIR : CATEGORY.HIGH_CARD;
}

function randomSizedRaise(legal) {
  const span = legal.maxRaiseTo - legal.minRaiseTo;
  return Math.min(legal.maxRaiseTo, legal.minRaiseTo + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0));
}

export function getDrunkAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const category = handCategoryOf(playerId, hand);
  const rand = Math.random();

  if (legal.check) {
    // Bets a decent chunk of the time even with nothing - but also checks
    // a real hand about as often as it bets one. Not tied to strength.
    if (legal.bet && rand < 0.35) {
      const wild = rand < 0.10; // occasional wildly oversized shove, any hand
      return { action: "bet", amount: wild ? legal.maxRaiseTo : randomSizedRaise(legal) };
    }
    return { action: "check" };
  }

  if (legal.call || legal.raise) {
    // Only a mild nudge from actually having a hand - mostly just noise.
    const foldChance = category >= CATEGORY.ONE_PAIR ? 0.15 : 0.30;
    if (rand < foldChance) return { action: "fold" };

    if (legal.raise && rand > 0.72) {
      const wild = rand > 0.92; // occasional wildly oversized raise, any hand
      return { action: "raise", amount: wild ? legal.maxRaiseTo : randomSizedRaise(legal) };
    }
    return { action: "call" };
  }

  return { action: "fold" };
}
