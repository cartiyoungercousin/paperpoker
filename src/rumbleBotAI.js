// Decides whether a bot should activate its (unused) Rumble power-up this
// turn, and on what target if it needs one - called from TableGame's bot
// turn scheduling, before the bot's normal fold/check/call/bet/raise
// decision (see checkBotTurn() in src/tableGame.js). Deliberately a simple
// heuristic, same spirit as the existing easy/medium bot decision functions
// (src/bots/*.js) - reuses the same hand-category classification they use,
// not a new equity engine.
import { bestHand, CATEGORY } from "./handEvaluator.js";

// Prefers whoever's been the most recently aggressive (bet/raise) this hand
// among still-live opponents - a reasonable stand-in for "who looks
// dangerous right now" without any real opponent modeling. Falls back to a
// random live opponent if nobody's shown aggression yet.
function pickOpponentTarget(playerId, hand, tableGame) {
  const liveOpponents = hand.order.filter(
    (id) => id !== playerId && !hand.folded.has(id) && hand.holeCards.get(id)
  );
  if (liveOpponents.length === 0) return null;
  const actions = (tableGame && tableGame.currentHandActions) || [];
  const aggressors = actions
    .filter((a) => (a.action === "bet" || a.action === "raise") && liveOpponents.includes(a.actor))
    .map((a) => a.actor);
  if (aggressors.length > 0) return aggressors[aggressors.length - 1];
  return liveOpponents[Math.floor(Math.random() * liveOpponents.length)];
}

function classifyHandStrength(playerId, hand) {
  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length !== 2) return CATEGORY.HIGH_CARD;
  const board = hand.board;
  if (board.length === 0) {
    return holeCards[0].rank === holeCards[1].rank ? CATEGORY.ONE_PAIR : CATEGORY.HIGH_CARD;
  }
  try {
    return bestHand([...holeCards, ...board]).score[0];
  } catch (e) {
    return CATEGORY.HIGH_CARD;
  }
}

// Returns { use: boolean, target?: string }. Never throws - an unexpected
// hand state just reads as "don't use it this turn" rather than crashing
// the bot's whole turn.
function decidePowerUpUse(playerId, hand, powerUpKey, tableGame) {
  try {
    const legal = hand.legalActions(playerId);
    if (!legal) return { use: false };

    const handCategory = classifyHandStrength(playerId, hand);
    const rand = Math.random();
    const startingStack = (tableGame && tableGame.startingStack) || 1000;

    switch (powerUpKey) {
      case "xrayVision": {
        if (rand > 0.35) return { use: false };
        const target = pickOpponentTarget(playerId, hand, tableGame);
        return target ? { use: true, target } : { use: false };
      }
      case "deckWhisperer": {
        // A little more likely once there's an actual board to react to.
        const streetBoost = hand.board.length >= 3 ? 0.1 : 0;
        return { use: rand < 0.2 + streetBoost };
      }
      case "mindReader": {
        // X-Ray Vision's stronger sibling - saved a little more often for
        // when it really matters, hence the lower threshold than xrayVision.
        if (rand > 0.3) return { use: false };
        const target = pickOpponentTarget(playerId, hand, tableGame);
        return target ? { use: true, target } : { use: false };
      }
      case "sleightOfHand": {
        // Most useful trying to fix a weak hand while there's still runway
        // left to use the new card - skip it once the hand's basically over.
        const weak = handCategory <= CATEGORY.HIGH_CARD;
        return { use: weak && hand.board.length <= 3 && rand < 0.5 };
      }
      case "mulligan": {
        // Sleight of Hand's stronger sibling - same weak-hand/early-street
        // logic, just redrawing both cards instead of one.
        const weak = handCategory <= CATEGORY.HIGH_CARD;
        return { use: weak && hand.board.length <= 3 && rand < 0.4 };
      }
      case "freakyFriday": {
        // Only worth it holding a weak hand - reuses pickOpponentTarget's
        // aggressor-biased pick, since "whoever's been betting" is as good a
        // proxy for "probably has a better hand" as this bot AI has.
        const weak = handCategory <= CATEGORY.HIGH_CARD;
        if (!weak || hand.board.length > 3 || rand > 0.35) return { use: false };
        const target = pickOpponentTarget(playerId, hand, tableGame);
        return target ? { use: true, target } : { use: false };
      }
      case "insurance": {
        // Best used right before a real commitment - facing (or about to
        // make) a call/bet worth a meaningful chunk of the starting stack.
        const committing = legal.callAmount >= startingStack * 0.4;
        return { use: committing && rand < 0.7 };
      }
      case "bountyHunter": {
        // Best saved for a hand actually worth winning big.
        const strong = handCategory >= CATEGORY.TWO_PAIR;
        return { use: strong && rand < 0.6 };
      }
      case "freezeSilence": {
        if (rand > 0.3) return { use: false };
        const target = pickOpponentTarget(playerId, hand, tableGame);
        return target ? { use: true, target } : { use: false };
      }
      case "deadmansFold": {
        // A hedge against a hand going bad later - only worth activating
        // early, before any real chips are committed, and only worth it at
        // all with a hand shaky enough that folding later is plausible.
        const weak = handCategory <= CATEGORY.HIGH_CARD;
        return { use: weak && hand.board.length === 0 && rand < 0.3 };
      }
      default:
        return { use: false };
    }
  } catch (e) {
    return { use: false };
  }
}

export { decidePowerUpUse, pickOpponentTarget };
