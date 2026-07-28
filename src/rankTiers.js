// XP awarded/deducted per hand, by bot difficulty - larger swings at higher
// difficulty (a win means more, a loss stings more) since harder bots are a
// tougher, more meaningful test either way. Losses are deliberately kept
// well under half of that same difficulty's win amount (roughly a third) -
// a rough session shouldn't cost you nearly as much progress as a good one
// earns, even though losing at a tougher difficulty still stings a bit more
// than losing at an easier one.
const DIFFICULTY_XP = {
  easy: { win: 8, loss: -3 },
  medium: { win: 14, loss: -5 },
  hard: { win: 22, loss: -8 },
  expert: { win: 32, loss: -12 },
};

// Base XP scaled by how big YOUR OWN win or loss actually was this hand,
// relative to the fixed ranked starting stack - a min-bet hand and an
// all-in stack-off no longer cost/earn the same XP. Deliberately scaled by
// the player's own net result, not the hand's total pot size: pot size can
// be inflated by other players' action after you've already folded (a cheap
// fold shouldn't earn/cost pot-sized XP just because the remaining players
// kept battling), and undercounts a multi-way win where your own profit
// exceeds what you personally put in. Floored at 0.25x and capped at 3x the
// base amount so a tiny win/loss still means something and one huge one
// can't swing a whole session by itself. winLossAmount/startingStack are
// optional - omitting either (as every pre-existing call site did before
// scaling existed) falls back to the flat per-difficulty amount, unscaled.
function xpForHand(difficulty, won, winLossAmount, startingStack) {
  const entry = DIFFICULTY_XP[difficulty] || DIFFICULTY_XP.easy;
  const baseXp = won ? entry.win : entry.loss;
  if (winLossAmount == null || !startingStack) return baseXp;
  const ratio = winLossAmount / startingStack;
  const clamped = Math.min(3, Math.max(0.25, ratio));
  return Math.round(baseXp * clamped);
}

// 16 tiers, illustrative/tunable thresholds: fast early progress (a handful
// of hands from Bronze III to Bronze II), slow late progress (the last
// promotion alone is a 15,000 XP climb) - a CoD-style ladder curve.
const RANK_TIERS = [
  { key: "bronze", sub: 3, label: "Bronze III", threshold: 0 },
  { key: "bronze", sub: 2, label: "Bronze II", threshold: 150 },
  { key: "bronze", sub: 1, label: "Bronze I", threshold: 400 },
  { key: "silver", sub: 3, label: "Silver III", threshold: 800 },
  { key: "silver", sub: 2, label: "Silver II", threshold: 1400 },
  { key: "silver", sub: 1, label: "Silver I", threshold: 2200 },
  { key: "gold", sub: 3, label: "Gold III", threshold: 3200 },
  { key: "gold", sub: 2, label: "Gold II", threshold: 4500 },
  { key: "gold", sub: 1, label: "Gold I", threshold: 6200 },
  { key: "pokeraddict", sub: 3, label: "PokerAddict III", threshold: 8400 },
  { key: "pokeraddict", sub: 2, label: "PokerAddict II", threshold: 11200 },
  { key: "pokeraddict", sub: 1, label: "PokerAddict I", threshold: 14800 },
  { key: "pokerstar", sub: 3, label: "PokerStar III", threshold: 19500 },
  { key: "pokerstar", sub: 2, label: "PokerStar II", threshold: 25500 },
  { key: "pokerstar", sub: 1, label: "PokerStar I", threshold: 33500 },
  { key: "pokerprofessor", sub: null, label: "PokerProfessor", threshold: 48500 },
];

// Returns the tier a given total-XP value falls into, plus enough about the
// next tier for a client-side progress bar - always well-defined (XP is
// floored at 0 elsewhere, and anything at/above the top threshold just stays
// PokerProfessor with no "next").
function rankForXp(xp) {
  const safeXp = Math.max(0, xp || 0);
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if (RANK_TIERS[i].threshold <= safeXp) idx = i;
    else break;
  }
  const current = RANK_TIERS[idx];
  const next = RANK_TIERS[idx + 1] || null;
  return {
    key: current.key,
    sub: current.sub,
    label: current.label,
    threshold: current.threshold,
    nextLabel: next ? next.label : null,
    nextThreshold: next ? next.threshold : null,
    progress: next ? (safeXp - current.threshold) / (next.threshold - current.threshold) : 1,
  };
}

export { DIFFICULTY_XP, xpForHand, RANK_TIERS, rankForXp };
