/**
 * Easy Bot Logic:
 * - Plays very simply and "loose-passively".
 * - If it's a "check" option, it usually checks (90%).
 * - If there's a bet to call, it calls if it has "something" or just feels like it (60%).
 * - Rarely bets or raises (10%) unless it has a very strong hand.
 * - This bot doesn't look at pot odds or equity.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";

export function getEasyAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const holeCards = hand.holeCards.get(playerId);
  const board = hand.board;
  
  // A very simple "strength" assessment
  let handCategory = CATEGORY.HIGH_CARD;
  if (board.length === 0) {
    // Pre-flop: just check for a pair in hole
    if (holeCards[0].rank === holeCards[1].rank) handCategory = CATEGORY.ONE_PAIR;
    // Or high cards
    else if (holeCards[0].rank > 10 || holeCards[1].rank > 10) handCategory = CATEGORY.HIGH_CARD; 
  } else {
    // Post-flop: see what we have (works for flop=5, turn=6, river=7 cards)
    const best = bestHand([...holeCards, ...board]);
    handCategory = best.score[0];
  }

  const rand = Math.random();

  // 1. If we can check, check most of the time
  if (legal.check) {
    // Bet or raise more often to create action (25% of the time)
    if (rand < 0.25) {
      if (legal.bet) {
        const betAmt = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
        return { action: "bet", amount: betAmt };
      }
      if (legal.raise) {
        const raiseAmt = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
        return { action: "raise", amount: raiseAmt };
      }
    }
    return { action: "check" };
  }

  // 2. If we have to call
  if (legal.call || legal.raise) {
    // Call if we have any pair or better, or just 65% of the time anyway
    if (handCategory >= CATEGORY.ONE_PAIR || rand < 0.65) {
      // Sometimes raise back if we have a decent hand and can raise
      if (legal.raise && handCategory >= CATEGORY.ONE_PAIR && rand < 0.25) {
        const raiseAmt = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
        return { action: "raise", amount: raiseAmt };
      }
      return { action: "call" };
    }
    
    // Otherwise fold
    return { action: "fold" };
  }

  return { action: "fold" };
}
