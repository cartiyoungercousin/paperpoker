// Rumble power-ups: catalog + one handler per key. A handler's job is only
// to apply the mechanic itself (mutate hand/deck state as needed) and
// describe what happened - TableGame.applyPowerUp() owns the shared
// bookkeeping (turn/used-once guards, marking the power-up spent, and
// broadcasting the result) so every power-up gets that for free.
//
// Handler signature: (tableGame, hand, playerId, target) => result
//   result.error         - a string if the activation is invalid (e.g. bad
//                           target); TableGame aborts before marking used.
//   result.privateInfo   - extra data sent ONLY to the activating player
//                           (e.g. the specific card revealed/peeked) - never
//                           broadcast to anyone else.
//   result.revealPayload - extra data included in the public "someone used
//                           a power-up" broadcast everyone sees (beyond the
//                           power-up's own name/icon/target, which
//                           TableGame already adds) - most handlers don't
//                           need this, since the broadcast is deliberately
//                           just "X used <power-up>", not its result.
//
// v1 shipped 6 power-ups, one from each mechanical category, to prove out
// every "shape" the rest of the catalog would need (a pure reveal, a peek, a
// self-only deck swap, two pot-resolution effects, and the one restriction-
// type mechanic). This second wave adds 4 more (Mind Reader, Mulligan,
// Freaky Friday, Deadman's Fold), reusing that same catalog/dispatch pattern
// with no new infrastructure. Discard & Draw and The Thief are still
// deferred - both risk mechanical overlap with what's already here.
const POWER_UPS_CATALOG = [
  {
    key: "xrayVision",
    name: "X-Ray Vision",
    icon: "\u{1F441}\u{FE0F}", // 👁️
    category: "Information & Reconnaissance",
    description: "Reveal one hidden card from an opponent of your choice.",
    needsTarget: true,
  },
  {
    key: "deckWhisperer",
    name: "Deck Whisperer",
    icon: "\u{1F52E}", // 🔮
    category: "Information & Reconnaissance",
    description: "Secretly look at the next card to be dealt from the deck.",
    needsTarget: false,
  },
  {
    key: "mindReader",
    name: "Mind Reader",
    icon: "\u{1F9E0}", // 🧠
    category: "Information & Reconnaissance",
    description: "Reveal both hidden cards from an opponent of your choice.",
    needsTarget: true,
  },
  {
    key: "sleightOfHand",
    name: "Sleight of Hand",
    icon: "\u{1F0CF}", // 🃏
    category: "Card & Deck Manipulation",
    description: "Swap one of your hole cards with a random card from the top of the deck.",
    needsTarget: false,
  },
  {
    key: "mulligan",
    name: "Mulligan",
    icon: "\u{1F504}", // 🔄
    category: "Card & Deck Manipulation",
    description: "Discard both of your hole cards and draw two fresh ones from the deck.",
    needsTarget: false,
  },
  {
    key: "freakyFriday",
    name: "Freaky Friday",
    icon: "\u{1F500}", // 🔀
    category: "Card & Deck Manipulation",
    description: "Swap your entire hand with an opponent of your choice. No take-backs.",
    needsTarget: true,
  },
  {
    key: "insurance",
    name: "Insurance",
    icon: "\u{1F4B0}", // 💰
    category: "Pot & Betting Mechanics",
    description: "If you lose this hand after going all-in or calling a bet worth half your stack, reclaim 50% of your lost chips.",
    needsTarget: false,
  },
  {
    key: "bountyHunter",
    name: "Bounty Hunter",
    icon: "\u{1F3F9}", // 🏹
    category: "Pot & Betting Mechanics",
    description: "If you win this hand, receive an extra 25% bonus payout from the house.",
    needsTarget: false,
  },
  {
    key: "freezeSilence",
    name: "Freeze / Silence",
    icon: "\u{2744}\u{FE0F}", // ❄️
    category: "Pot & Betting Mechanics",
    description: "Force a targeted player to check or call for the rest of this betting round. They can't raise or fold.",
    needsTarget: true,
  },
  {
    key: "deadmansFold",
    name: "Deadman's Fold",
    icon: "\u{1F480}", // 💀
    category: "Pot & Betting Mechanics",
    description: "The next time you fold this hand, get every chip you put in back from the house.",
    needsTarget: false,
  },
];

function findPowerUp(key) {
  return POWER_UPS_CATALOG.find((p) => p.key === key) || null;
}

// Shared target validation for the two opponent-targeted power-ups - must
// name a real, still-live (not folded) opponent, not yourself.
function resolveLiveOpponent(hand, playerId, target) {
  if (!target || target === playerId) return { error: "Choose an opponent to target." };
  if (!hand.order.includes(target)) return { error: "Unknown target." };
  if (hand.folded.has(target)) return { error: "That player has already folded." };
  if (!hand.holeCards.get(target)) return { error: "That player has no cards." };
  return { id: target };
}

function xrayVision(tableGame, hand, playerId, target) {
  const resolved = resolveLiveOpponent(hand, playerId, target);
  if (resolved.error) return { error: resolved.error };
  const cards = hand.holeCards.get(resolved.id);
  const card = cards[0];
  return { privateInfo: { type: "xrayVision", target: resolved.id, card } };
}

function deckWhisperer(tableGame, hand) {
  if (hand.deck.remaining() < 1) return { error: "The deck is empty." };
  const [card] = hand.deck.peek(1);
  return { privateInfo: { type: "deckWhisperer", card } };
}

// Mind Reader is X-Ray Vision's stronger sibling - both of the target's
// hole cards instead of just one.
function mindReader(tableGame, hand, playerId, target) {
  const resolved = resolveLiveOpponent(hand, playerId, target);
  if (resolved.error) return { error: resolved.error };
  const cards = hand.holeCards.get(resolved.id);
  return { privateInfo: { type: "mindReader", target: resolved.id, cards: [cards[0], cards[1]] } };
}

function sleightOfHand(tableGame, hand, playerId) {
  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { error: "You have no cards to swap." };
  if (hand.deck.remaining() < 1) return { error: "The deck is empty." };
  const [newCard] = hand.deck.draw(1);
  const oldCard = holeCards[0];
  hand.holeCards.set(playerId, [newCard, holeCards[1]]);
  return { privateInfo: { type: "sleightOfHand", oldCard, newCard } };
}

// Mulligan is Sleight of Hand's stronger sibling - both hole cards instead
// of just one.
function mulligan(tableGame, hand, playerId) {
  const holeCards = hand.holeCards.get(playerId);
  if (!holeCards || holeCards.length < 2) return { error: "You have no cards to redraw." };
  if (hand.deck.remaining() < 2) return { error: "The deck doesn't have enough cards left." };
  const newCards = hand.deck.draw(2);
  const oldCards = [holeCards[0], holeCards[1]];
  hand.holeCards.set(playerId, newCards);
  return { privateInfo: { type: "mulligan", oldCards, newCards } };
}

// A straight hand-for-hand trade with a chosen opponent - no deck draw
// involved, so it can't ever fail on an empty deck the way the swap-based
// power-ups can. No privateInfo beyond the swap itself: the activator's own
// hole cards already update in their own hand display on the very next
// state push, same as any other hand change.
function freakyFriday(tableGame, hand, playerId, target) {
  const resolved = resolveLiveOpponent(hand, playerId, target);
  if (resolved.error) return { error: resolved.error };
  const myCards = hand.holeCards.get(playerId);
  const theirCards = hand.holeCards.get(resolved.id);
  if (!myCards || !theirCards) return { error: "Missing hole cards to swap." };
  hand.holeCards.set(playerId, theirCards);
  hand.holeCards.set(resolved.id, myCards);
  return {};
}

// Insurance/Bounty Hunter don't do anything immediately - they just flag
// this player as eligible for a payout adjustment once THIS hand resolves.
// Tracked on the Hand instance (transient, per-hand) rather than on
// TableGame, since it only ever matters for whichever hand it was used in -
// see TableGame.handleHandComplete()'s rumble payout-adjustment step.
function insurance(tableGame, hand, playerId) {
  if (!hand._rumbleInsurancePlayers) hand._rumbleInsurancePlayers = new Set();
  hand._rumbleInsurancePlayers.add(playerId);
  return {};
}

function bountyHunter(tableGame, hand, playerId) {
  if (!hand._rumbleBountyPlayers) hand._rumbleBountyPlayers = new Set();
  hand._rumbleBountyPlayers.add(playerId);
  return {};
}

// Same flag-now/resolve-later shape as Insurance/Bounty Hunter, but checked
// against fold rather than the payout - see TableGame's rumble payout-
// adjustment step, which refunds totalContributed for anyone flagged here
// who ends up in hand.folded by the time the hand resolves.
function deadmansFold(tableGame, hand, playerId) {
  if (!hand._rumbleDeadmansFoldPlayers) hand._rumbleDeadmansFoldPlayers = new Set();
  hand._rumbleDeadmansFoldPlayers.add(playerId);
  return {};
}

// Sets a restriction directly on the CURRENT BettingRound - deliberately not
// on Hand or TableGame, so it naturally expires the moment the street
// changes (_startStreet() always builds a brand-new BettingRound instance,
// see src/hand.js) without needing any explicit cleanup. That matches the
// power-up's own wording: "during that betting round."
function freezeSilence(tableGame, hand, playerId, target) {
  const resolved = resolveLiveOpponent(hand, playerId, target);
  if (resolved.error) return { error: resolved.error };
  if (!hand.currentRound) return { error: "No active betting round." };
  const targetPlayer = hand.currentRound.getPlayer(resolved.id);
  if (!targetPlayer || targetPlayer.allIn) return { error: "That player has no more decisions to make." };
  hand.currentRound.frozenPlayerId = resolved.id;
  return {};
}

const POWER_UP_HANDLERS = {
  xrayVision,
  deckWhisperer,
  mindReader,
  sleightOfHand,
  mulligan,
  freakyFriday,
  insurance,
  bountyHunter,
  freezeSilence,
  deadmansFold,
};

export { POWER_UPS_CATALOG, POWER_UP_HANDLERS, findPowerUp };
