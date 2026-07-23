// Hand categories, higher number = better hand.
export const CATEGORY = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
};

// Evaluates exactly 5 cards. Returns a "score" array where the first
// element is the category and the rest are tiebreakers, most significant
// first. Two scores can be compared lexicographically: index 0 first,
// then index 1, etc.
export function evaluate5(cards) {
  if (cards.length !== 5) {
    throw new Error("evaluate5 requires exactly 5 cards");
  }

  const ranksDesc = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Map();
  for (const r of ranksDesc) counts.set(r, (counts.get(r) || 0) + 1);

  // groups: [rank, count], sorted by count desc, then rank desc
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniqueRanksDesc = [...new Set(ranksDesc)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueRanksDesc.length === 5) {
    if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) {
      isStraight = true;
      straightHigh = uniqueRanksDesc[0];
    } else if (uniqueRanksDesc.join(",") === "14,5,4,3,2") {
      // wheel: A-2-3-4-5, Ace plays low, straight high card is 5
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return [CATEGORY.STRAIGHT_FLUSH, straightHigh];

  if (groups[0][1] === 4) {
    const kicker = groups[1][0];
    return [CATEGORY.FOUR_OF_A_KIND, groups[0][0], kicker];
  }

  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return [CATEGORY.FULL_HOUSE, groups[0][0], groups[1][0]];
  }

  if (isFlush) return [CATEGORY.FLUSH, ...ranksDesc];

  if (isStraight) return [CATEGORY.STRAIGHT, straightHigh];

  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.THREE_OF_A_KIND, groups[0][0], ...kickers];
  }

  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairRanks = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups[2][0];
    return [CATEGORY.TWO_PAIR, ...pairRanks, kicker];
  }

  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.ONE_PAIR, groups[0][0], ...kickers];
  }

  return [CATEGORY.HIGH_CARD, ...ranksDesc];
}

// Returns positive if a > b, negative if a < b, 0 if exactly tied.
export function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

// Given 7 cards (2 hole + 5 board), finds the best possible 5-card hand.
// Returns { score, cards } where cards is the best 5-card combination.
export function bestOf7(sevenCards) {
  if (sevenCards.length !== 7) {
    throw new Error("bestOf7 requires exactly 7 cards");
  }
  const combos = combinations(sevenCards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (best === null || compareScores(score, best.score) > 0) {
      best = { score, cards: combo };
    }
  }
  return best;
}
