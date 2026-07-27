/**
 * Hard Bot Logic:
 * - Plays "tight-aggressive" (TAG): selective pre-flop, aggressive post-flop.
 * - Pre-flop: only plays premium hands (pairs 77+, ATs+, AQo+, KQs).
 * - Uses position awareness (acts stronger in late position).
 * - Post-flop: bets for value with strong hands, semi-bluffs with draws,
 *   folds weak hands to aggression.
 * - Occasionally check-raises (15%).
 * - Adjusts bet sizing (smaller for draws, larger for made hands).
 */

import { bestHand, CATEGORY, compareScores } from "../handEvaluator.js";

// Premium hand ranges
function isPremiumPreflop(holeCards) {
  const [c1, c2] = holeCards;
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);

  // Pairs 77+
  if (pair && c1.rank >= 7) return true;
  // ATs+, AQo+
  if (suited && high === 14 && low >= 10) return true;
  if (!suited && high === 14 && low >= 12) return true;
  // KQs
  if (suited && high === 13 && low === 12) return true;
  // AKo always
  if (high === 14 && low === 13) return true;

  return false;
}

// Marginal hands that can be played in position
function isMarginalPreflop(holeCards) {
  const [c1, c2] = holeCards;
  const suited = c1.suit === c2.suit;
  const connectors = Math.abs(c1.rank - c2.rank) <= 2;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);

  // Pairs 22-66
  if (c1.rank === c2.rank) return true;
  // Suited connectors 65s+
  if (suited && connectors && low >= 5) return true;
  // Suited aces A2s-A9s
  if (suited && high === 14 && low <= 9) return true;
  // KQo, KJs
  if (high === 13 && low >= 11) return true;

  return false;
}

export function getHardAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { action: "fold" };
  const board = hand.board;

  // Determine position (late = dealer or one off)
  const order = hand.order;
  const myIndex = order.indexOf(playerId);
  const dealerIndex = hand.dealerIndex;
  const totalPlayers = order.length;
  const distFromDealer = (myIndex - dealerIndex + totalPlayers) % totalPlayers;
  const latePosition = distFromDealer <= 1 || distFromDealer >= totalPlayers - 1;

  const rand = Math.random();

  if (board.length === 0) {
    // Pre-flop
    const premium = isPremiumPreflop(holeCards);
    const marginal = isMarginalPreflop(holeCards);

    if (legal.check) {
      if (premium) {
        if (rand < 0.7 && legal.bet) {
          // Standard raise 3-4 BB
          const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.15), legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
        return { action: "check" };
      }
      if (marginal && latePosition && rand < 0.4) {
        if (legal.bet) {
          const betAmt = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
      }
      if (rand < 0.15) return { action: "check" }; // defend blinds occasionally
      return { action: "fold" };
    }

    if (legal.call) {
      if (premium) {
        // Raise to isolate
        if (legal.raise && rand < 0.6) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.2), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }
      if (marginal && (latePosition || rand < 0.3)) return { action: "call" };
      if (rand < 0.1) return { action: "call" }; // defend
      return { action: "fold" };
    }

    return { action: "fold" };
  } else {
    // Post-flop
    const combined = [...holeCards, ...board];
    const best = bestHand(combined);
    const cat = best.score[0];
    const hasTopPair = cat >= CATEGORY.ONE_PAIR && best.score[1] >= board[0].rank;
    const overpair = cat === CATEGORY.ONE_PAIR && best.score[1] > Math.max(...board.map(c => c.rank));

    // Check for draws (straight or flush draw)
    const suits = combined.map(c => c.suit);
    const suitCounts = {};
    for (const s of suits) suitCounts[s] = (suitCounts[s] || 0) + 1;
    const flushDraw = Object.values(suitCounts).some(c => c >= 4);

    const ranks = combined.map(c => c.rank).sort((a, b) => a - b);
    let straightDraw = false;
    for (let i = 0; i <= ranks.length - 4; i++) {
      if (ranks[i+3] - ranks[i] <= 3) { straightDraw = true; break; }
    }
    // Also check for gutshot (4 cards to a straight with one gap)
    for (let i = 0; i <= ranks.length - 4; i++) {
      let unique = [...new Set(ranks.slice(i, i+4))].sort((a,b) => a-b);
      if (unique.length === 4 && unique[3] - unique[0] <= 4) { straightDraw = true; break; }
    }

    const hasDraw = flushDraw || straightDraw;
    const strongHand = cat >= CATEGORY.THREE_OF_A_KIND || (cat === CATEGORY.TWO_PAIR && best.score[2] >= 10);
    const madeHand = cat >= CATEGORY.ONE_PAIR && (hasTopPair || overpair);
    const weakHand = cat < CATEGORY.ONE_PAIR;

    if (legal.check) {
      // Strong: bet for value
      if (strongHand || madeHand) {
        if (rand < 0.75 && legal.bet) {
          const betAmt = strongHand
            ? Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.5), legal.maxRaiseTo)
            : Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.35), legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
        return { action: "check" };
      }
      // Draw: semi-bluff
      if (hasDraw && rand < 0.4 && legal.bet) {
        const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.25), legal.maxRaiseTo);
        return { action: "bet", amount: betAmt };
      }
      // Weak: check or small bluff
      if (rand < 0.1 && legal.bet) {
        const betAmt = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
        return { action: "bet", amount: betAmt };
      }
      return { action: "check" };
    }

    if (legal.call) {
      const toCall = legal.callAmount || 0;

      // Strong: raise for value
      if (strongHand) {
        if (legal.raise && rand < 0.7) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.6), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }

      // Made hand: call reasonable bets
      if (madeHand) {
        if (legal.raise && rand < 0.2 && toCall < 30) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.3), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        if (toCall > 50 && rand < 0.3) return { action: "fold" }; // fold to big bets
        return { action: "call" };
      }

      // Draw: call if good odds (small bet)
      if (hasDraw) {
        if (toCall > 40 && rand < 0.4) return { action: "fold" };
        return { action: "call" };
      }

      // Weak: fold to any bet
      if (rand < 0.08) return { action: "call" }; // tiny bluff
      return { action: "fold" };
    }

    // Last resort
    if (legal.check) return { action: "check" };
    if (legal.call) return { action: "call" };
    return { action: "fold" };
  }
}

