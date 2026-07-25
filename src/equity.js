// Computes win probability ("equity") for players whose hole cards are
// known, given a partially- or fully-dealt board. Used for the "All-In
// Equity" stat: when a hand goes all-in before the river, the remaining
// community cards are pure chance - this module answers "what was each
// player's true win probability at that moment," independent of how the
// actual runout happened to fall.
//
// Two strategies, picked automatically based on how many board cards are
// still unknown:
//   - Exact enumeration (need <= 2 cards): the unseen pool is small enough
//     (at most ~1000 combinations) to enumerate every possible runout.
//   - Monte Carlo sampling (need = 5, i.e. an all-in before the flop): exact
//     enumeration would mean ~1.7M combinations, each requiring a full
//     hand evaluation per participant - far too slow to run synchronously
//     on every hand. 25,000 random samples gives a standard error of about
//     +/-0.3 percentage points on a 50/50 spot, which is more than precise
//     enough for a session "luck" indicator.

import { bestHand, compareScores } from "./handEvaluator.js";

const SUITS = ["h", "d", "c", "s"];

function fullDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) cards.push({ rank, suit });
  }
  return cards;
}

function cardKey(card) {
  return card.rank + card.suit;
}

// Cards no one has seen yet: the full deck minus known hole cards and the
// board dealt so far. Burn cards are deliberately not modeled - burning
// doesn't change the probability distribution of the remaining visible
// board cards, since they're still a uniformly random subset of the unseen
// deck regardless of what gets burned alongside them.
function unseenPool(participants, boardAtAllIn) {
  const dealt = new Set();
  for (const p of participants) {
    for (const c of p.holeCards) dealt.add(cardKey(c));
  }
  for (const c of boardAtAllIn) dealt.add(cardKey(c));
  return fullDeck().filter((c) => !dealt.has(cardKey(c)));
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

// Given a fully-dealt board, returns the id(s) of the participant(s) with
// the best hand (more than one id means a tie/split).
function winnersForRunout(participants, board) {
  let bestIds = [];
  let bestScore = null;
  for (const p of participants) {
    const best = bestHand([...p.holeCards, ...board]);
    if (bestScore === null || compareScores(best.score, bestScore) > 0) {
      bestScore = best.score;
      bestIds = [p.id];
    } else if (compareScores(best.score, bestScore) === 0) {
      bestIds.push(p.id);
    }
  }
  return bestIds;
}

// Enumerates every possible remaining runout exactly. Only practical when
// the unseen pool times the number of cards needed stays small (see the
// dispatcher below for the cutoff).
export function computeAllInEquityExact({ participants, boardAtAllIn }) {
  const need = 5 - boardAtAllIn.length;
  const unseen = unseenPool(participants, boardAtAllIn);
  const wins = {};
  const ties = {};
  for (const p of participants) {
    wins[p.id] = 0;
    ties[p.id] = 0;
  }

  const runouts = need > 0 ? combinations(unseen, need) : [[]];
  for (const extra of runouts) {
    const winners = winnersForRunout(participants, [...boardAtAllIn, ...extra]);
    if (winners.length === 1) {
      wins[winners[0]]++;
    } else {
      for (const id of winners) ties[id] += 1 / winners.length;
    }
  }

  const total = runouts.length;
  const equity = {};
  for (const p of participants) {
    equity[p.id] = total > 0 ? (wins[p.id] + ties[p.id]) / total : 0;
  }
  return equity;
}

// Random-sampling estimate of the same thing, for when exact enumeration
// would be too slow (a preflop all-in, need === 5).
export function computeAllInEquityMonteCarlo({ participants, boardAtAllIn, samples = 25000, rng = Math.random }) {
  const need = 5 - boardAtAllIn.length;
  const basePool = unseenPool(participants, boardAtAllIn);
  const wins = {};
  const ties = {};
  for (const p of participants) {
    wins[p.id] = 0;
    ties[p.id] = 0;
  }

  for (let t = 0; t < samples; t++) {
    // Partial Fisher-Yates: only shuffle as many positions as we need to draw.
    const pool = [...basePool];
    const extra = [];
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      extra.push(pool[i]);
    }
    const winners = winnersForRunout(participants, [...boardAtAllIn, ...extra]);
    if (winners.length === 1) {
      wins[winners[0]]++;
    } else {
      for (const id of winners) ties[id] += 1 / winners.length;
    }
  }

  const equity = {};
  for (const p of participants) {
    equity[p.id] = (wins[p.id] + ties[p.id]) / samples;
  }
  return equity;
}

// Picks exact enumeration when it's cheap (turn/flop-stage all-ins - at most
// ~1000 runouts), Monte Carlo otherwise (a preflop all-in).
export function computeAllInEquity(args) {
  const need = 5 - args.boardAtAllIn.length;
  return need <= 2 ? computeAllInEquityExact(args) : computeAllInEquityMonteCarlo(args);
}

// Monte Carlo equity for a hero against N opponents with UNKNOWN hole cards
// (e.g. "what was my equity on the flop against whoever was still in the
// hand" for the hand replayer). This is fundamentally different from the
// all-in functions above: exact enumeration is infeasible once you're
// summing over multiple unknown 2-card hands, so this is always an estimate
// and should be labeled as such in the UI, not presented as exact equity.
export function estimateEquityVsUnknown({ heroHoleCards, board, numOpponents, samples = 3000, rng = Math.random }) {
  if (numOpponents <= 0) return 1;
  const dealt = new Set([...heroHoleCards, ...board].map(cardKey));
  const pool = fullDeck().filter((c) => !dealt.has(cardKey(c)));
  const cardsNeeded = numOpponents * 2 + (5 - board.length);

  let winSum = 0;
  for (let t = 0; t < samples; t++) {
    // Partial Fisher-Yates: shuffle just enough of the pool to draw what we need.
    const shuffled = [...pool];
    for (let i = 0; i < cardsNeeded; i++) {
      const j = i + Math.floor(rng() * (shuffled.length - i));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const drawn = shuffled.slice(0, cardsNeeded);
    const runoutBoard = [...board, ...drawn.slice(numOpponents * 2)];

    const participants = [{ id: "hero", holeCards: heroHoleCards }];
    for (let o = 0; o < numOpponents; o++) {
      participants.push({ id: `opp${o}`, holeCards: drawn.slice(o * 2, o * 2 + 2) });
    }
    // Reuses the same fractional tie-splitting as the all-in functions above,
    // rather than a naive "beaten by anyone = loss" shortcut, which would
    // mishandle rare multi-way ties.
    const winners = winnersForRunout(participants, runoutBoard);
    if (winners.includes("hero")) winSum += 1 / winners.length;
  }

  return winSum / samples;
}
