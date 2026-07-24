/**
 * Expert Bot Logic:
 * - Uses pot odds, implied odds, hand range analysis
 * - 3-bet/4-bet logic with range-based decisions
 * - Adjustable personality (TAG, LAG, Loose-Passive, etc.)
 * - Passive/Aggressive slider (0-100)
 * - Bluff frequency control
 * - Fold to 3-bet sensitivity
 */

import { bestHand, CATEGORY, compareScores, evaluate5 } from "../handEvaluator.js";
import { rankName } from "../deck.js";

// Personality presets
const PERSONALITY_PRESETS = {
  'TAG': { vpip: 0.20, pfr: 0.15, bluffFreq: 0.12, foldTo3bet: 0.70, aggression: 70, cbFreq: 0.80 },
  'LAG': { vpip: 0.35, pfr: 0.25, bluffFreq: 0.25, foldTo3bet: 0.50, aggression: 75, cbFreq: 0.65 },
  'tight-passive': { vpip: 0.15, pfr: 0.06, bluffFreq: 0.05, foldTo3bet: 0.85, aggression: 30, cbFreq: 0.40 },
  'loose-passive': { vpip: 0.45, pfr: 0.08, bluffFreq: 0.08, foldTo3bet: 0.80, aggression: 25, cbFreq: 0.30 },
  'maniac': { vpip: 0.55, pfr: 0.40, bluffFreq: 0.40, foldTo3bet: 0.30, aggression: 95, cbFreq: 0.90 },
  'calling-station': { vpip: 0.50, pfr: 0.03, bluffFreq: 0.02, foldTo3bet: 0.90, aggression: 10, cbFreq: 0.15 },
};

// Default traits if no customization passed
let botTraits = { personality: 'TAG', aggression: 50, bluffFreq: 0.15, foldTo3bet: 0.65 };

export function setExpertBotTraits(traits) {
  if (traits.personality && PERSONALITY_PRESETS[traits.personality]) {
    botTraits.personality = traits.personality;
  }
  if (traits.aggression !== undefined) botTraits.aggression = traits.aggression;
  if (traits.bluffFreq !== undefined) botTraits.bluffFreq = traits.bluffFreq;
  if (traits.foldTo3bet !== undefined) botTraits.foldTo3bet = traits.foldTo3bet;
}

function getTraitValue(key) {
  const preset = PERSONALITY_PRESETS[botTraits.personality] || PERSONALITY_PRESETS['TAG'];
  // Blend personality preset with user slider
  const presetVal = preset[key] || 0.5;
  if (key === 'aggression') {
    return (presetVal + (botTraits.aggression / 100)) / 2;
  }
  if (key === 'bluffFreq') {
    return (presetVal + botTraits.bluffFreq) / 2;
  }
  if (key === 'foldTo3bet') {
    return (presetVal + botTraits.foldTo3bet) / 2;
  }
  return presetVal;
}

// Calculate pot odds
function getPotOdds(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal || !legal.call) return 0;
  const toCall = legal.callAmount;
  let pot = 0;
  for (const v of hand.totalContributed.values()) pot += v;
  if (hand.currentRound) {
    for (const p of hand.currentRound.players) pot += p.contributed;
  }
  if (toCall <= 0) return 1;
  return toCall / (pot + toCall);
}

// Calculate hand equity roughly (simplified)
function estimateEquity(holeCards, board, numPlayers) {
  if (board.length === 0) {
    // Pre-flop: simple hand strength estimation
    const [c1, c2] = holeCards;
    const pair = c1.rank === c2.rank;
    const suited = c1.suit === c2.suit;
    const high = Math.max(c1.rank, c2.rank);
    const low = Math.min(c1.rank, c2.rank);
    let equity = 0.08; // base
    if (pair) equity += c1.rank * 0.02;
    if (high >= 14) equity += 0.08;
    if (high >= 13) equity += 0.05;
    if (high >= 12) equity += 0.03;
    if (suited) equity += 0.02;
    if (high - low <= 2) equity += 0.02;
    // Premium hands
    if (pair && c1.rank >= 10) equity += 0.05;
    if (high === 14 && low >= 13) equity += 0.06;
    // Adjust for number of players
    equity = equity / (0.12 * numPlayers);
    return Math.min(Math.max(equity, 0.02), 0.85);
  } else {
    // Post-flop: use actual hand evaluation
    const combined = [...holeCards, ...board];
    const best = bestHand(combined);
    const cat = best.score[0];
    const ranks = combined.map(c => c.rank);
    const suits = combined.map(c => c.suit);

    // Check draws
    const suitCounts = {};
    for (const s of suits) suitCounts[s] = (suitCounts[s] || 0) + 1;
    const flushDraw = Object.values(suitCounts).some(c => c >= 4);
    let straightDraw = false;
    const uniqueRanks = [...new Set(ranks)].sort((a,b) => a-b);
    for (let i = 0; i <= uniqueRanks.length - 4; i++) {
      if (uniqueRanks[i+3] - uniqueRanks[i] <= 4) { straightDraw = true; break; }
    }

    let equity = 0;
    switch (cat) {
      case CATEGORY.STRAIGHT_FLUSH: equity = 0.95; break;
      case CATEGORY.FOUR_OF_A_KIND: equity = 0.90; break;
      case CATEGORY.FULL_HOUSE: equity = 0.85; break;
      case CATEGORY.FLUSH: equity = 0.75; break;
      case CATEGORY.STRAIGHT: equity = 0.70; break;
      case CATEGORY.THREE_OF_A_KIND: equity = 0.65; break;
      case CATEGORY.TWO_PAIR: equity = 0.55; break;
      case CATEGORY.ONE_PAIR: equity = 0.40; break;
      default: equity = 0.15; break;
    }
    if (flushDraw) equity += 0.08;
    if (straightDraw) equity += 0.06;
    // Adjust for board texture
    if (board.length >= 3) {
      const paired = new Set(board.map(c => c.rank)).size < board.length;
      const threeFlush = Object.values(suitCounts).some(c => c >= 3);
      if (paired) equity *= 0.95;
      if (threeFlush && !flushDraw) equity *= 0.90;
    }
    return Math.min(Math.max(equity, 0.02), 0.95);
  }
}

export function getExpertAction(playerId, hand, customization = {}) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  // Apply customization if provided
  const traits = { ...botTraits };
  if (customization.personality && PERSONALITY_PRESETS[customization.personality]) {
    traits.personality = customization.personality;
  }
  if (customization.aggression !== undefined) traits.aggression = customization.aggression;
  if (customization.bluffFreq !== undefined) traits.bluffFreq = customization.bluffFreq;
  if (customization.foldTo3bet !== undefined) traits.foldTo3bet = customization.foldTo3bet;

  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { action: "fold" };
  const board = hand.board;

  // Get blended personality values
  const preset = PERSONALITY_PRESETS[traits.personality] || PERSONALITY_PRESETS['TAG'];
  const aggression = (preset.aggression + traits.aggression) / 200; // 0-1
  const bluffFreq = (preset.bluffFreq + traits.bluffFreq) / 2;
  const foldTo3bet = (preset.foldTo3bet + traits.foldTo3bet) / 2;
  const vpip = preset.vpip;
  const pfr = preset.pfr;
  const cbFreq = preset.cbFreq;

  const rand = Math.random();
  const potOdds = getPotOdds(playerId, hand);
  const numActive = hand._activePlayers ? hand._activePlayers().length : hand.order.length;
  const equity = estimateEquity(holeCards, board, numActive);

  // Determine position
  const order = hand.order;
  const myIndex = order.indexOf(playerId);
  const dealerIndex = hand.dealerIndex;
  const totalPlayers = order.length;
  const distFromDealer = (myIndex - dealerIndex + totalPlayers) % totalPlayers;
  const latePosition = distFromDealer <= 2 || distFromDealer >= totalPlayers - 1;

  // Check if facing a 3-bet
  let facing3bet = false;
  if (hand.currentRound) {
    const lastRaise = hand.currentRound.currentBet;
    if (lastRaise >= hand.bigBlind * 3) facing3bet = true;
  }

  if (board.length === 0) {
    // === PRE-FLOP ===
    const [c1, c2] = holeCards;
    const pair = c1.rank === c2.rank;
    const suited = c1.suit === c2.suit;
    const high = Math.max(c1.rank, c2.rank);
    const low = Math.min(c1.rank, c2.rank);

    // Premium holdings (top 5%): QQ+, AKs
    const premium = (pair && c1.rank >= 12) || (high === 14 && low === 13);
    // Strong holdings (top 15%): TT+, AQ+, KQs, AJs
    const strong = (pair && c1.rank >= 10) || (high === 14 && low >= 12) || (suited && high === 13 && low === 12) || (suited && high === 14 && low >= 11);
    // Playable (top 30%): pairs, suited aces, broadways, suited connectors
    const playable = pair || high >= 11 || (suited && low >= 8 && high - low <= 3) || (suited && low >= 5 && high - low <= 2);

    // Check VPIP threshold
    if (!premium && !strong && rand > vpip) {
      if (legal.check) return { action: "check" };
      if (!legal.call) return { action: "fold" };
      if (rand < 0.3 && playable) return { action: "call" };
      return { action: "fold" };
    }

    if (legal.check) {
      if (premium && rand < pfr * 1.5) {
        if (legal.bet) {
          const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.2 * aggression), legal.maxRaiseTo);
          return { action: "bet", amount: Math.max(legal.minRaiseTo, betAmt) };
        }
      }
      if ((strong || playable) && rand < pfr * aggression && latePosition) {
        if (legal.bet) {
          return { action: "bet", amount: legal.minRaiseTo };
        }
      }
      if (playable || rand < 0.5) return { action: "check" };
      // Blind defense
      if (rand < 0.3 && (high >= 9 || suited)) return { action: "check" };
      return { action: "fold" };
    }

    if (legal.call) {
      const toCall = legal.callAmount || 0;
      const pot = hand.totalContributed.size > 0 ? [...hand.totalContributed.values()].reduce((a,b) => a+b, 0) : hand.bigBlind * 2;
      const potOddsCall = toCall / (pot + toCall);

      // Facing 3-bet
      if (facing3bet) {
        if (premium && rand < 0.7) {
          // 4-bet or call
          if (legal.raise && rand < 0.5) {
            const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.3), legal.maxRaiseTo);
            return { action: "raise", amount: raiseAmt };
          }
          return { action: "call" };
        }
        if (strong && rand < (1 - foldTo3bet)) return { action: "call" };
        if (rand < foldTo3bet) return { action: "fold" };
        if (playable && potOddsCall < 0.2 && latePosition) return { action: "call" };
        return { action: "fold" };
      }

      // Normal pre-flop decision
      if (premium) {
        if (legal.raise && rand < pfr) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.25 * aggression), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }
      if (strong) {
        if (legal.raise && rand < pfr * 0.6 && latePosition) {
          return { action: "raise", amount: legal.minRaiseTo };
        }
        if (potOddsCall < 0.3) return { action: "call" };
        return { action: "fold" };
      }
      if (playable && potOddsCall < 0.25) return { action: "call" };
      if (rand < 0.1) return { action: "call" }; // occasional defend
      return { action: "fold" };
    }

    return { action: "fold" };
  } else {
    // === POST-FLOP ===
    const combined = [...holeCards, ...board];
    const best = bestHand(combined);
    const cat = best.score[0];
    const hasTopPair = cat >= CATEGORY.ONE_PAIR && best.score[1] >= board[0].rank;
    const overpair = cat === CATEGORY.ONE_PAIR && best.score[1] > Math.max(...board.map(c => c.rank));
    const strongHand = cat >= CATEGORY.THREE_OF_A_KIND || cat === CATEGORY.TWO_PAIR;
    const madeHand = cat >= CATEGORY.ONE_PAIR && (hasTopPair || overpair);
    const weakHand = cat < CATEGORY.ONE_PAIR;

    // Draw detection
    const allSuits = combined.map(c => c.suit);
    const suitCounts = {};
    for (const s of allSuits) suitCounts[s] = (suitCounts[s] || 0) + 1;
    const flushDraw = Object.values(suitCounts).some(c => c >= 4);
    const nutFlushDraw = flushDraw && holeCards[0].suit === board[0].suit &&
      holeCards[0].rank >= 14;
    let straightDraw = false;
    let openEnded = false;
    const uniqueRanks = [...new Set(combined.map(c => c.rank))].sort((a,b) => a-b);
    for (let i = 0; i <= uniqueRanks.length - 4; i++) {
      if (uniqueRanks[i+3] - uniqueRanks[i] <= 4) {
        straightDraw = true;
        if (uniqueRanks[i+3] - uniqueRanks[i] <= 3) openEnded = true;
      }
    }
    const hasDraw = flushDraw || straightDraw;

    // Pot odds based decision
    if (legal.check) {
      // Strong: bet for value proportional to aggression
      if (strongHand || madeHand) {
        if (rand < cbFreq * aggression && legal.bet) {
          const betAmt = strongHand
            ? Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.6 * aggression), legal.maxRaiseTo)
            : Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.4 * aggression), legal.maxRaiseTo);
          return { action: "bet", amount: betAmt };
        }
        return { action: "check" };
      }
      // Draw: semi-bluff based on aggression
      if (hasDraw && rand < aggression * 0.5 && legal.bet) {
        const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.3 * aggression), legal.maxRaiseTo);
        return { action: "bet", amount: betAmt };
      }
      // Bluff occasionally
      if (rand < bluffFreq * aggression && legal.bet) {
        return { action: "bet", amount: legal.minRaiseTo };
      }
      // Check weak/medium hands
      return { action: "check" };
    }

    if (legal.call) {
      const toCall = legal.callAmount || 0;

      // Pot odds calculation
      let potTotal = 0;
      for (const v of hand.totalContributed.values()) potTotal += v;
      if (hand.currentRound) {
        for (const p of hand.currentRound.players) potTotal += p.contributed;
      }
      const potOddsCall = toCall > 0 ? toCall / (potTotal + toCall) : 0;

      // Strong: raise for value
      if (strongHand) {
        if (legal.raise && rand < aggression) {
          const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.5 * aggression), legal.maxRaiseTo);
          return { action: "raise", amount: raiseAmt };
        }
        return { action: "call" };
      }

      // Made hand: call or fold based on pot odds
      if (madeHand) {
        if (potOddsCall > 0.3 && rand < 0.4) return { action: "fold" };
        if (legal.raise && rand < 0.15 && potOddsCall < 0.15) {
          return { action: "raise", amount: legal.minRaiseTo };
        }
        return { action: "call" };
      }

      // Draw: call only if good pot odds
      if (hasDraw) {
        const drawEquity = flushDraw ? 0.35 : openEnded ? 0.32 : 0.15;
        if (drawEquity > potOddsCall || rand < 0.3) {
          if (legal.raise && rand < 0.2 && flushDraw && latePosition) {
            return { action: "raise", amount: Math.min(legal.minRaiseTo, legal.maxRaiseTo) };
          }
          return { action: "call" };
        }
        return { action: "fold" };
      }

      // Weak hand
      if (equity > potOddsCall && rand < 0.1) return { action: "call" };
      if (rand < bluffFreq * 0.3 && legal.raise) {
        return { action: "raise", amount: legal.minRaiseTo };
      }
      return { action: "fold" };
    }

    if (legal.check) return { action: "check" };
    if (legal.call) return { action: "call" };
    return { action: "fold" };
  }
}

