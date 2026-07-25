import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAllInEquityExact,
  computeAllInEquityMonteCarlo,
  computeAllInEquity,
  estimateEquityVsUnknown,
} from "../src/equity.js";

function c(rank, suit) {
  return { rank, suit };
}

// Small deterministic PRNG (mulberry32) so Monte Carlo tests are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("computeAllInEquityExact: hand-verifiable turn-stage all-in (flush vs. trips needing to fill up)", () => {
  const participants = [
    { id: "A", holeCards: [c(14, "h"), c(10, "h")] }, // Ah Th - already has ace-high flush (with 2h 5h 9h)
    { id: "B", holeCards: [c(9, "c"), c(9, "d")] }, // 9c 9d - trip nines via board's 9h, needs to fill up
  ];
  const boardAtAllIn = [c(2, "h"), c(5, "h"), c(9, "h"), c(13, "c")]; // 2h 5h 9h Kc
  const equity = computeAllInEquityExact({ participants, boardAtAllIn });

  // Unseen pool = 52 - 8 = 44 cards. B only wins by pairing the board (K, 2, or 5 -
  // 3 unseen copies each = 9 outs) for a full house, or catching the last 9 (1 out)
  // for quads: exactly 10 winning rivers. A wins every other river (flush always
  // beats trips, and no ties are possible in this matchup).
  assert.equal(equity.B, 10 / 44);
  assert.equal(equity.A, 34 / 44);
  assert.equal(equity.A + equity.B, 1);
});

test("computeAllInEquityExact splits equity 50/50 when both hands are guaranteed to tie", () => {
  // Both players' hole cards share the same ranks (just different suits), and the
  // board's own two pair (KKQQ) dwarfs both - so whichever card comes on the river,
  // both players' best 5-card kicker-adjusted hand value is identical.
  const participants = [
    { id: "A", holeCards: [c(2, "c"), c(3, "d")] },
    { id: "B", holeCards: [c(2, "h"), c(3, "s")] },
  ];
  const boardAtAllIn = [c(13, "s"), c(13, "d"), c(12, "h"), c(12, "c")]; // Ks Kd Qh Qc
  const equity = computeAllInEquityExact({ participants, boardAtAllIn });

  assert.equal(equity.A, 0.5);
  assert.equal(equity.B, 0.5);
});

test("computeAllInEquityMonteCarlo approximates the well-known AA vs KK preflop matchup (~82/18)", () => {
  const participants = [
    { id: "A", holeCards: [c(14, "h"), c(14, "d")] }, // AA
    { id: "B", holeCards: [c(13, "h"), c(13, "d")] }, // KK
  ];
  const equity = computeAllInEquityMonteCarlo({
    participants,
    boardAtAllIn: [],
    samples: 20000,
    rng: mulberry32(42),
  });

  assert.ok(Math.abs(equity.A - 0.82) < 0.02, `AA equity should be close to 82%, got ${equity.A}`);
  assert.ok(Math.abs(equity.B - 0.18) < 0.02, `KK equity should be close to 18%, got ${equity.B}`);
  assert.ok(Math.abs(equity.A + equity.B - 1) < 1e-9);
});

test("computeAllInEquityMonteCarlo is deterministic given the same seeded rng", () => {
  const participants = [
    { id: "A", holeCards: [c(14, "s"), c(13, "s")] }, // AKs
    { id: "B", holeCards: [c(8, "h"), c(8, "d")] }, // 88
  ];
  const run = () =>
    computeAllInEquityMonteCarlo({ participants, boardAtAllIn: [], samples: 5000, rng: mulberry32(7) });

  const first = run();
  const second = run();
  assert.equal(first.A, second.A);
  assert.equal(first.B, second.B);
});

test("Monte Carlo converges toward the exact value for a flop-stage (need=2) matchup", () => {
  const participants = [
    { id: "A", holeCards: [c(14, "s"), c(13, "s")] }, // AKs with a flush draw
    { id: "B", holeCards: [c(8, "h"), c(8, "d")] }, // 88, overpair to the board
  ];
  const boardAtAllIn = [c(9, "s"), c(4, "s"), c(2, "c")]; // two spades - A has a flush draw + overcards
  const exact = computeAllInEquityExact({ participants, boardAtAllIn });
  const mc = computeAllInEquityMonteCarlo({ participants, boardAtAllIn, samples: 20000, rng: mulberry32(99) });

  assert.ok(Math.abs(exact.A - mc.A) < 0.02, `exact=${exact.A} vs monte carlo=${mc.A} should be close`);
});

test("computeAllInEquity dispatches to exact enumeration for need <= 2 and matches computeAllInEquityExact directly", () => {
  const participants = [
    { id: "A", holeCards: [c(14, "h"), c(10, "h")] },
    { id: "B", holeCards: [c(9, "c"), c(9, "d")] },
  ];
  const boardAtAllIn = [c(2, "h"), c(5, "h"), c(9, "h"), c(13, "c")]; // need = 1 (turn all-in)
  const viaDispatcher = computeAllInEquity({ participants, boardAtAllIn });
  const direct = computeAllInEquityExact({ participants, boardAtAllIn });

  assert.deepEqual(viaDispatcher, direct);
});

test("estimateEquityVsUnknown approximates the well-known AA vs. one random hand preflop (~85%)", () => {
  const equity = estimateEquityVsUnknown({
    heroHoleCards: [c(14, "h"), c(14, "d")],
    board: [],
    numOpponents: 1,
    samples: 8000,
    rng: mulberry32(11),
  });
  assert.ok(Math.abs(equity - 0.85) < 0.04, `AA heads-up equity should be close to 85%, got ${equity}`);
});

test("estimateEquityVsUnknown decreases monotonically as more opponents are added", () => {
  const heroHoleCards = [c(14, "h"), c(13, "h")]; // AKs
  const board = [c(12, "h"), c(6, "d"), c(2, "c")]; // flush draw + overcards
  const equity1 = estimateEquityVsUnknown({ heroHoleCards, board, numOpponents: 1, samples: 4000, rng: mulberry32(1) });
  const equity2 = estimateEquityVsUnknown({ heroHoleCards, board, numOpponents: 2, samples: 4000, rng: mulberry32(2) });
  const equity3 = estimateEquityVsUnknown({ heroHoleCards, board, numOpponents: 3, samples: 4000, rng: mulberry32(3) });

  assert.ok(equity1 > equity2, `equity vs 1 opp (${equity1}) should beat equity vs 2 opps (${equity2})`);
  assert.ok(equity2 > equity3, `equity vs 2 opps (${equity2}) should beat equity vs 3 opps (${equity3})`);
});

test("estimateEquityVsUnknown returns 1 when there are no opponents left", () => {
  const equity = estimateEquityVsUnknown({
    heroHoleCards: [c(2, "h"), c(3, "d")],
    board: [c(9, "s"), c(8, "d"), c(4, "c")],
    numOpponents: 0,
  });
  assert.equal(equity, 1);
});
