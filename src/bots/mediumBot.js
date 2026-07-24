/**
 * Medium Bot Logic:
 * - Plays "tight-passive" — selective with hands, but plays them well.
 * - Pre-flop: only plays pairs, high cards (10+), and suited connectors.
 * - Post-flop: bets/raises with top pair or better, checks/calls with draws.
 * - Occasionally bluffs (15%).
 * - Folds weak hands to aggression.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";

export function getMediumAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { action: "fold" };
  const board = hand.board;

  let handCategory = CATEGORY.HIGH_CARD;
  let allRanks = holeCards.map(c => c.rank).sort((a, b) => b - a);

  if (board.length === 0) {
    // Pre-flop hand assessment
    const pair = holeCards[0].rank === holeCards[1].rank;
    const suited = holeCards[0].suit === holeCards[1].suit;
    const highCard = holeCards[0].rank >= 10 || holeCards[1].rank >= 10;
    const connectors = Math.abs(holeCards[0].rank - holeCards[1].rank) <= 3;

    // Premium hands: QQ+, AK
    const premium = (pair && holeCards[0].rank >= 12) || (holeCards[0].rank === 14 && holeCards[1].rank === 13);
    // Playable hands: pairs, high cards, suited connectors
    const playable = pair || highCard || (suited && connectors);

    if (premium) {
      handCategory = CATEGORY.TWO_PAIR; // treat as strong
    } else if (pair && holeCards[0].rank >= 8) {
      handCategory = CATEGORY.ONE_PAIR; // medium pair
    } else if (playable) {
      handCategory = CATEGORY.HIGH_CARD; // marginal
    }
    // else: fold material

    const rand = Math.random();

    if (legal.check) {
      if (premium && rand < 0.6) {
        if (legal.bet) {
          const betAmt = Math.min(legal.minRaiseTo + 20, legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
        if (legal.raise) {
          const raiseAmt = Math.min(legal.minRaiseTo + 20, legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
      }
      if (playable || rand < 0.5) return { action: "check" };
      return { action: "fold" };
    }

    if (legal.call) {
      if (premium) {
        if (legal.raise && rand < 0.4) {
          const raiseAmt = Math.min(legal.minRaiseTo + 30, legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }
      if (playable && rand < 0.6) return { action: "call" };
      if (rand < 0.2) return { action: "call" }; // sometimes call anyway
      return { action: "fold" };
    }

    return { action: "fold" };
  } else {
    // Post-flop
    const combined = [...holeCards, ...board];
    const best = bestHand(combined);
    handCategory = best.score[0];
    const hasTopPair = handCategory >= CATEGORY.ONE_PAIR && best.score[1] >= board[0].rank;

    const rand = Math.random();

    if (legal.check) {
      if ((handCategory === CATEGORY.ONE_PAIR && hasTopPair)) {
        if (rand < 0.5 && legal.bet) {
          const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.3), legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
        return { action: "check" };
      }
      if (handCategory >= CATEGORY.ONE_PAIR || rand < 0.4) return { action: "check" };
      return { action: "fold" };
    }

    if (legal.call) {
      if (handCategory >= CATEGORY.THREE_OF_A_KIND) {
        if (legal.raise && rand < 0.5) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.4), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }
      if (handCategory >= CATEGORY.ONE_PAIR) return { action: "call" };
      if (rand < 0.25) return { action: "call" }; // bluff occasionally
      return { action: "fold" };
    }
  }

  if (legal.check) return { action: "check" };
  if (legal.call) return { action: "call" };
  return { action: "fold" };
}

