// The Spins wheel - a lightweight, instant "pay SPIN_COST coins, get a
// random coin or XP reward back" attraction. Deliberately NOT wired through
// TableGame (there's no hand/session context involved) - just a flat REST
// call in server.js, closer in shape to the daily-reward claim than to
// anything hand-lifecycle-reactive.
const SPIN_COST = 25;

// Segment order here is also the WHEEL's own visual order (see
// SPIN_SEGMENTS mirrored in index.html) - the server rolls an index into
// this array and the client spins its wheel graphic to land on that exact
// slice, so the two arrays must stay the same length/order.
//
// Weights are chosen so the average COIN payout sits well below the 25-coin
// cost (coin EV is ~12.8 - see test/spinConfig.test.js - spinning purely
// for coins is a losing bet on average, same "coins have real scarcity"
// philosophy as the rest of the economy: Ranked earns none, Rumble pays a
// flat +2 on a session win, Tournament entry fees are real non-refundable
// stakes). Every segment still pays out SOMETHING (no "you win nothing"
// slice - this is meant to feel generous even when it's a net coin cost),
// and XP-only segments give a reason to spin beyond pure coin gambling. The
// rare jackpot is what keeps a spin exciting despite the modest house edge.
const SPIN_SEGMENTS = [
  { key: "coins5", type: "coins", amount: 5, label: "5 Coins", weight: 25 },
  { key: "xp10", type: "xp", amount: 10, label: "10 XP", weight: 20 },
  { key: "coins15", type: "coins", amount: 15, label: "15 Coins", weight: 18 },
  { key: "xp20", type: "xp", amount: 20, label: "20 XP", weight: 15 },
  { key: "coins30", type: "coins", amount: 30, label: "30 Coins", weight: 12 },
  { key: "xp40", type: "xp", amount: 40, label: "40 XP", weight: 6 },
  { key: "coins75", type: "coins", amount: 75, label: "75 Coins", weight: 3 },
  { key: "jackpot300", type: "coins", amount: 300, label: "JACKPOT! 300 Coins", weight: 1 },
];
const SPIN_WEIGHT_TOTAL = SPIN_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);

// Weighted-random pick, server-side only - the client never gets any say in
// the outcome, only the index to visually spin toward once the server has
// already decided. Math.random() is fine here (not cryptographic stakes,
// same trust level already given to bot AI decisions elsewhere).
function pickSpinSegment() {
  let roll = Math.random() * SPIN_WEIGHT_TOTAL;
  for (let i = 0; i < SPIN_SEGMENTS.length; i++) {
    roll -= SPIN_SEGMENTS[i].weight;
    if (roll <= 0) return { segment: SPIN_SEGMENTS[i], index: i };
  }
  const lastIndex = SPIN_SEGMENTS.length - 1;
  return { segment: SPIN_SEGMENTS[lastIndex], index: lastIndex }; // floating-point safety net
}

export { SPIN_COST, SPIN_SEGMENTS, SPIN_WEIGHT_TOTAL, pickSpinSegment };
