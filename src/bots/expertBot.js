/**
 * Expert Bot Logic:
 * - Real Monte Carlo equity (estimateEquityVsUnknown), not a hand-category
 *   lookup table - every decision is grounded in an actual probability.
 * - EV-correct call/fold gating (the same pot-odds formula handAnalysis.js's
 *   gradeDecision uses to grade a human's decisions), so "should I call"
 *   answers the right question instead of rolling dice against a magic
 *   number that never consulted the price being laid.
 * - Minimum Defense Frequency (MDF): even when the raw math says fold, a
 *   hand that isn't pure air occasionally continues anyway, at roughly the
 *   rate needed to stop being an auto-profitable bluffing target - a real
 *   GTO-adjacent defensive principle, not just "call sometimes."
 * - Bet sizing is pot-relative, and bluffing frequency is DERIVED from that
 *   sizing (bigger bets bluff more often, by the standard break-even ratio
 *   bet/(pot+bet)) rather than a flat, sizing-blind probability.
 * - Adjustable personality (TAG, LAG, Loose-Passive, etc.) still exists and
 *   stays meaningfully distinct - it now modulates the EV-correct baseline
 *   (fold/call margin, bluff-ratio multiplier, value-bet frequency) instead
 *   of replacing it outright.
 *
 * None of this is a real solver (no CFR, no full range trees) - it's a
 * real-time heuristic bot, and it stays one. What changed is that its
 * heuristics are now grounded in actual equity and actual pot odds instead
 * of a hardcoded strength table and ungrounded random rolls.
 */

import { bestHand, CATEGORY } from "../handEvaluator.js";
import { estimateEquityVsUnknown } from "../equity.js";

// Personality presets
const PERSONALITY_PRESETS = {
  'TAG': { vpip: 0.20, pfr: 0.15, bluffFreq: 0.12, foldTo3bet: 0.70, aggression: 70, cbFreq: 0.80 },
  'LAG': { vpip: 0.35, pfr: 0.25, bluffFreq: 0.25, foldTo3bet: 0.50, aggression: 75, cbFreq: 0.65 },
  'tight-passive': { vpip: 0.15, pfr: 0.06, bluffFreq: 0.05, foldTo3bet: 0.85, aggression: 30, cbFreq: 0.40 },
  'loose-passive': { vpip: 0.45, pfr: 0.08, bluffFreq: 0.08, foldTo3bet: 0.80, aggression: 25, cbFreq: 0.30 },
  'maniac': { vpip: 0.55, pfr: 0.40, bluffFreq: 0.40, foldTo3bet: 0.30, aggression: 95, cbFreq: 0.90 },
  'calling-station': { vpip: 0.50, pfr: 0.03, bluffFreq: 0.02, foldTo3bet: 0.90, aggression: 10, cbFreq: 0.15 },
};

// Real-time equity budget - see src/equity.js. Measured cost scales with
// opponent count, not board length/street: ~40ms worst case at 300 samples
// and 6 opponents, negligible against the 500ms (turbo) / 2500-4000ms
// (normal) bot-turn delay in tableGame.js's checkBotTurn(). The Analyzer's
// own post-hoc equity display uses 3000 samples for tighter precision - that
// stays a once-per-hand-review call, not a real-time one, so it's untouched.
const EQUITY_SAMPLES = 300;
const MAX_EQUITY_OPPONENTS = 6;

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

// Total chips in the pot right now: everything already folded into
// hand.totalContributed by a prior street closing, PLUS whatever's been
// contributed so far in the still-open current street (hand.currentRound).
// Both halves are needed - totalContributed alone is 0 for the entire
// preflop street (blinds/calls only land there once the street closes),
// which is exactly the bug the old per-branch inline pot math had (it fell
// back to a flat hand.bigBlind*2 guess preflop instead of the real number).
function potNow(hand) {
  let pot = 0;
  for (const v of hand.totalContributed.values()) pot += v;
  if (hand.currentRound) {
    for (const p of hand.currentRound.players) pot += p.contributed;
  }
  return pot;
}

// Real Monte Carlo equity (see src/equity.js) against however many
// opponents are still live, capped for cost safety. Replaces the old
// hand-category lookup table entirely - this is an actual probability, not
// a guess keyed on "flush = 0.75."
function computeEquity(holeCards, board, numOpponents, samples, rng) {
  const cappedOpp = Math.max(0, Math.min(numOpponents, MAX_EQUITY_OPPONENTS));
  return estimateEquityVsUnknown({ heroHoleCards: holeCards, board, numOpponents: cappedOpp, samples, rng });
}

// The same pot-odds formula handAnalysis.js's gradeDecision() uses to grade
// a human's decisions - reused here rather than reinvented, so "was this
// call correct" means the same thing everywhere in the app.
function evGate(equity, potBefore, toCall) {
  if (toCall <= 0) return { requiredEquity: 0, evCall: potBefore, correctToCall: true };
  const potAfterCall = potBefore + toCall;
  const requiredEquity = toCall / potAfterCall;
  const evCall = equity * potAfterCall - toCall;
  return { requiredEquity, evCall, correctToCall: evCall >= 0 };
}

// How far above/below the raw break-even line a personality needs to be
// before it'll actually fold/call - derived from vpip (how loose the preset
// plays overall), not foldTo3bet (which measures 3-bet-specific stickiness,
// not general postflop/preflop calling tendency). Positive = folds some
// marginally +EV spots (tighter than break-even); negative = calls some
// marginally -EV spots (looser than break-even). Clamped so no preset goes
// absurdly far from the actual math.
function marginThreshold(vpip) {
  return Math.min(0.06, Math.max(-0.12, (0.30 - vpip) * 0.4));
}

// Hero's hole cards beat the board's best card - a live overcard even
// without a made pair or draw, the kind of residual equity that keeps a
// hand from being "pure air" for MDF-defense purposes.
function overcardToBoard(holeCards, board) {
  if (!board || board.length === 0) return false;
  const heroHigh = Math.max(holeCards[0].rank, holeCards[1].rank);
  const boardHigh = Math.max(...board.map((c) => c.rank));
  return heroHigh > boardHigh;
}

// Shared "facing a bet" decision used by every call/fold branch below
// (preflop normal, preflop facing a 3-bet, postflop madeHand/draw/weak).
// EV-correct baseline (evGate), personality-biased by marginThresh, with a
// damped Minimum-Defense-Frequency fallback for hands that aren't pure air:
// even a bet that's technically -EV to call needs to be called SOME of the
// time, or a bot that folds every -EV spot with mathematical precision
// becomes exploitable by anyone who just bets big with air. mdf*0.5 (not
// full mdf) is a deliberate damper - this bot's "not air" bucket is broader
// than a solved range would use (it includes bare live overcards a real
// solve might auto-fold), so defending at the full MDF rate would
// over-defend; halving it keeps the spirit ("occasionally defend") without
// spewing chips into hopeless spots.
function decideFacingBet({ equity, pot, toCall, marginThresh, notAir, rand }) {
  const gate = evGate(equity, pot, toCall);
  const margin = equity - gate.requiredEquity;
  if (margin >= marginThresh) return "continue";
  if (notAir) {
    const mdf = pot / (pot + toCall);
    if (rand < mdf * 0.5) return "continue";
  }
  return "fold";
}

// Sizes a bet/raise as a fraction of the current pot rather than a fraction
// of the (stack-dependent) legal raise range - standard sizing convention,
// and what the bluff-ratio math in getExpertAction() below assumes. Works
// for both a fresh bet (currentBet 0, raiseTo reduces to just the sized
// amount) and a raise (currentBet > 0, raiseTo = currentBet + the sized
// increment) - legalActions()'s minRaiseTo/maxRaiseTo/bet amount are all
// "raise-to" totals, confirmed against bettingRound.js, not increments.
function potRelativeBet(fraction, legal, pot, currentBet) {
  const raiseTo = currentBet + pot * fraction;
  return Math.round(Math.min(Math.max(raiseTo, legal.minRaiseTo), legal.maxRaiseTo));
}

// Premium hand ranges
function isPremiumPreflop(holeCards) {
  const [c1, c2] = holeCards;
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);

  // QQ+
  if (pair && c1.rank >= 12) return true;
  // AKs
  if (suited && high === 14 && low === 13) return true;
  return false;
}

// Strong (but not premium) hands
function isStrongPreflop(holeCards) {
  const [c1, c2] = holeCards;
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);

  // TT+
  if (pair && c1.rank >= 10) return true;
  // AQ+
  if (high === 14 && low >= 12) return true;
  // KQs, AJs
  if (suited && high === 13 && low === 12) return true;
  if (suited && high === 14 && low === 11) return true;
  return false;
}

// Playable (top ~30%): pairs, suited aces, broadways, suited connectors
function isPlayablePreflop(holeCards) {
  const [c1, c2] = holeCards;
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);

  if (pair) return true;
  if (high >= 11) return true;
  if (suited && low >= 8 && high - low <= 3) return true;
  if (suited && low >= 5 && high - low <= 2) return true;
  return false;
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
  const equitySamples = customization.equitySamples || EQUITY_SAMPLES;
  const equityRng = customization.equityRng || Math.random;

  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { action: "fold" };
  const board = hand.board;

  // Get blended personality values
  const preset = PERSONALITY_PRESETS[traits.personality] || PERSONALITY_PRESETS['TAG'];
  const aggression = (preset.aggression + traits.aggression) / 200; // 0-1
  const bluffFreq = (preset.bluffFreq + traits.bluffFreq) / 2;
  const vpip = preset.vpip;
  const pfr = preset.pfr;
  const cbFreq = preset.cbFreq;
  const marginThresh = marginThreshold(vpip);

  const rand = Math.random();
  const numActive = hand._activePlayers ? hand._activePlayers().length : hand.order.length;
  // numOpponents EXCLUDES the hero - estimateEquityVsUnknown's own param
  // already means "opponents", not "everyone at the table."
  const equity = computeEquity(holeCards, board, numActive - 1, equitySamples, equityRng);
  const pot = potNow(hand);

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
    const suited = c1.suit === c2.suit;

    const premium = isPremiumPreflop(holeCards);
    const strong = isStrongPreflop(holeCards);
    const playable = isPlayablePreflop(holeCards);

    // Check VPIP threshold - non-premium/strong hands only enter the pot at
    // roughly the preset's real voluntary-play rate.
    if (!premium && !strong && rand > vpip) {
      if (legal.check) return { action: "check" };
      if (!legal.call) return { action: "fold" };
      // A fresh, independent draw here - reusing rand (already > vpip to
      // have reached this branch) would perversely correlate the two
      // checks: for any preset with vpip >= 0.3 (LAG, maniac, loose-passive,
      // calling-station), "rand > vpip" and "rand < 0.3" can never both be
      // true with the SAME rand, silently disabling this looser call-anyway
      // defense exactly for the presets meant to use it most.
      if (Math.random() < 0.3 && playable) return { action: "call" };
      return { action: "fold" };
    }

    if (legal.check) {
      // Checking is always free - there is never a correct reason to fold
      // here, only whether to also raise for value/isolation on top of it.
      if (premium && rand < pfr * 1.5 && legal.bet) {
        const betAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.2 * aggression), legal.maxRaiseTo);
        return { action: "bet", amount: Math.max(legal.minRaiseTo, betAmt) };
      }
      if ((strong || playable) && rand < pfr * aggression && latePosition && legal.bet) {
        return { action: "bet", amount: legal.minRaiseTo };
      }
      return { action: "check" };
    }

    if (legal.call) {
      const toCall = legal.callAmount || 0;

      // Facing 3-bet
      if (facing3bet) {
        if (premium) {
          if (legal.raise && rand < 0.5) {
            const raiseAmt = Math.min(legal.minRaiseTo + Math.floor(legal.maxRaiseTo * 0.3), legal.maxRaiseTo);
            return { action: "raise", amount: raiseAmt };
          }
          return { action: "call" };
        }
        const notAir = strong || (playable && suited);
        const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir, rand });
        return outcome === "continue" ? { action: "call" } : { action: "fold" };
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
        const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir: true, rand });
        return outcome === "continue" ? { action: "call" } : { action: "fold" };
      }
      const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir: playable, rand });
      return outcome === "continue" ? { action: "call" } : { action: "fold" };
    }

    return { action: "fold" };
  } else {
    // === POST-FLOP ===
    const combined = [...holeCards, ...board];
    const best = bestHand(combined);
    const cat = best.score[0];
    const hasTopPair = cat >= CATEGORY.ONE_PAIR && best.score[1] >= board[0].rank;
    const overpair = cat === CATEGORY.ONE_PAIR && best.score[1] > Math.max(...board.map((c) => c.rank));
    const strongHand = cat >= CATEGORY.THREE_OF_A_KIND || cat === CATEGORY.TWO_PAIR;
    const madeHand = cat >= CATEGORY.ONE_PAIR && (hasTopPair || overpair);

    // Draw detection
    const allSuits = combined.map((c) => c.suit);
    const suitCounts = {};
    for (const s of allSuits) suitCounts[s] = (suitCounts[s] || 0) + 1;
    const flushDraw = Object.values(suitCounts).some((c) => c >= 4);
    let straightDraw = false;
    const uniqueRanks = [...new Set(combined.map((c) => c.rank))].sort((a, b) => a - b);
    for (let i = 0; i <= uniqueRanks.length - 4; i++) {
      if (uniqueRanks[i + 3] - uniqueRanks[i] <= 4) straightDraw = true;
    }
    const hasDraw = flushDraw || straightDraw;
    // Not pure air for MDF-defense purposes: a live draw, a real (if
    // non-top) pair, or a bare overcard to the board - explicitly excludes
    // a hand with none of those, which must still fold to stay coherent.
    const notAirPostflop = hasDraw || cat === CATEGORY.ONE_PAIR || overcardToBoard(holeCards, board);

    const currentBet = hand.currentRound ? hand.currentRound.currentBet : 0;

    if (legal.check) {
      // Strong/made: bet for value, sized to hand strength.
      if (strongHand || madeHand) {
        if (rand < cbFreq * aggression && legal.bet) {
          const fraction = strongHand ? 0.55 + 0.15 * aggression : 0.45 + 0.10 * aggression;
          return { action: "bet", amount: potRelativeBet(fraction, legal, pot, currentBet) };
        }
        return { action: "check" };
      }
      // Draw: semi-bluff, sized smaller than a pure bluff since it has real backup equity.
      if (hasDraw && rand < aggression * 0.5 && legal.bet) {
        const fraction = 0.50 + 0.25 * aggression;
        return { action: "bet", amount: potRelativeBet(fraction, legal, pot, currentBet) };
      }
      // Pure bluff (no pair, no draw): size first, then derive the
      // bluffing frequency from that sizing - a bet of size B into pot P
      // only needs to be a bluff alpha = B/(P+B) of the time to be
      // break-even against a caller who defends correctly (the standard
      // polarized-range approximation). bluffFreq/0.15 lets personality
      // scale around that break-even line (0.15 = TAG's roughly-neutral
      // baseline) rather than replacing it with an ungrounded flat number.
      if (legal.bet) {
        const fraction = 0.70 + 0.35 * aggression;
        const betAmt = potRelativeBet(fraction, legal, pot, currentBet);
        const betSize = betAmt - currentBet;
        const alpha = betSize / (pot + betSize);
        const actualBluffFreq = Math.min(0.95, Math.max(0, alpha * (bluffFreq / 0.15)));
        if (rand < actualBluffFreq) return { action: "bet", amount: betAmt };
      }
      return { action: "check" };
    }

    if (legal.call) {
      const toCall = legal.callAmount || 0;

      // Strong: raise for value
      if (strongHand) {
        if (legal.raise && rand < aggression) {
          const fraction = 0.55 + 0.15 * aggression;
          return { action: "raise", amount: potRelativeBet(fraction, legal, pot, currentBet) };
        }
        return { action: "call" };
      }

      // Made hand: EV-correct call/fold (with MDF fallback), occasional raise
      if (madeHand) {
        const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir: true, rand });
        if (outcome === "fold") return { action: "fold" };
        if (legal.raise && rand < 0.15) {
          const fraction = 0.45 + 0.10 * aggression;
          return { action: "raise", amount: potRelativeBet(fraction, legal, pot, currentBet) };
        }
        return { action: "call" };
      }

      // Draw: EV-correct call/fold (equity already reflects the draw's real
      // chance to improve), occasional semi-bluff raise with the best draws.
      if (hasDraw) {
        const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir: true, rand });
        if (outcome === "fold") return { action: "fold" };
        if (legal.raise && rand < 0.2 && flushDraw && latePosition) {
          const fraction = 0.50 + 0.25 * aggression;
          return { action: "raise", amount: potRelativeBet(fraction, legal, pot, currentBet) };
        }
        return { action: "call" };
      }

      // Weak hand: EV-correct call/fold (MDF-defended if there's a live
      // overcard or backup pair), otherwise a sizing-derived bluff-raise on
      // a genuine minority of the truly air hands - same break-even ratio
      // as the check-branch bluff above, damped further (*0.3) since
      // raising into an existing bet risks more than betting first in.
      const outcome = decideFacingBet({ equity, pot, toCall, marginThresh, notAir: notAirPostflop, rand });
      if (outcome === "continue") return { action: "call" };
      if (legal.raise) {
        const fraction = 0.70 + 0.35 * aggression;
        const betAmt = potRelativeBet(fraction, legal, pot, currentBet);
        const addedSize = betAmt - currentBet;
        const alpha = addedSize / (pot + addedSize);
        const actualBluffFreq = Math.min(0.95, Math.max(0, alpha * (bluffFreq / 0.15) * 0.3));
        if (rand < actualBluffFreq) return { action: "raise", amount: betAmt };
      }
      return { action: "fold" };
    }

    if (legal.check) return { action: "check" };
    if (legal.call) return { action: "call" };
    return { action: "fold" };
  }
}
