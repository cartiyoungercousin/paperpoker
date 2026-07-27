/**
 * The Maniac (experimental, 1v1 only):
 * - Bets and raises almost constantly, regardless of hand strength.
 * - Rarely folds even under real pressure.
 * - Pure chaos, not a calculated bluff mix like the Bluffer - there's no
 *   real hand-strength read driving most of these decisions at all.
 */

const RAISE_FREQUENCY = 0.75;
const FOLD_FREQUENCY = 0.08;

function randomSizedRaise(legal) {
  const span = legal.maxRaiseTo - legal.minRaiseTo;
  return Math.min(legal.maxRaiseTo, legal.minRaiseTo + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0));
}

export function getManiacAction(playerId, hand) {
  const legal = hand.legalActions(playerId);
  if (!legal) return null;

  const rand = Math.random();

  if (legal.check) {
    // Both branches cover "checked to me with the option to open betting" -
    // legal.bet when nobody's put in a bet yet this street, legal.raise for
    // the big-blind-option case where the blind itself counts as the bet.
    if (rand < RAISE_FREQUENCY) {
      if (legal.bet) return { action: "bet", amount: randomSizedRaise(legal) };
      if (legal.raise) return { action: "raise", amount: randomSizedRaise(legal) };
    }
    return { action: "check" };
  }

  if (legal.call || legal.raise) {
    if (legal.raise && rand < RAISE_FREQUENCY) {
      return { action: "raise", amount: randomSizedRaise(legal) };
    }
    if (rand < 1 - FOLD_FREQUENCY) return { action: "call" };
    return { action: "fold" };
  }

  return { action: "fold" };
}
