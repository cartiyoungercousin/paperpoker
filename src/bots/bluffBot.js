/**
 * Bluffer Bot Logic (experimental, solo/unranked only):
 * - Bets and raises far more often than hand strength alone would justify.
 * - Still shows up with real premium hands often enough that always
 *   assuming a bluff is the wrong read - the aggression isn't hollow every time.
 * - Gives up on weak hands under real pressure often enough to not go broke
 *   every single time it gets called.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";

const BLUFF_FREQUENCY = 0.55;

function isStrong(playerId, hand) {
  const holeCards = hand.holeCards.get(playerId);
  const board = hand.board;
  if (board.length > 0) {
    const best = bestHand([...holeCards, ...board]);
    return best.score[0] >= CATEGORY.ONE_PAIR;
  }
  // Preflop: treat pairs and big cards as "the real thing" for this bot's own read.
  return holeCards[0].rank === holeCards[1].rank || holeCards[0].rank >= 12 || holeCards[1].rank >= 12;
}

function randomSizedRaise(legal) {
  const span = legal.maxRaiseTo - legal.minRaiseTo;
  return Math.min(legal.maxRaiseTo, legal.minRaiseTo + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0));
}

export function getBluffAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const strong = isStrong(playerId, hand);
  const rand = Math.random();

  if (legal.check) {
    // Bets a lot - for value with a real hand, and as a pure bluff otherwise.
    if (legal.bet && (strong || rand < BLUFF_FREQUENCY)) {
      return { action: "bet", amount: randomSizedRaise(legal) };
    }
    return { action: "check" };
  }

  if (legal.call || legal.raise) {
    if (strong) {
      if (legal.raise && rand < 0.4) return { action: "raise", amount: randomSizedRaise(legal) };
      return { action: "call" };
    }
    // Weak hand: sometimes barrels on as a bluff-raise, sometimes calls it
    // down lighter than a straightforward bot would, sometimes gives up -
    // deliberately not a single predictable pattern.
    if (legal.raise && rand < BLUFF_FREQUENCY * 0.6) {
      return { action: "raise", amount: randomSizedRaise(legal) };
    }
    if (rand < 0.35) return { action: "call" };
    return { action: "fold" };
  }

  return { action: "fold" };
}
