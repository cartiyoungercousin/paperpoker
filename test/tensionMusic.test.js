import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.join(__dirname, "..", "tension-music.js");
const code = fs.readFileSync(scriptPath, "utf8");

test("tension-music.js parses without syntax errors", () => {
  new Function(code);
});

// Loaded in a sandboxed vm context (no DOM) - tension-music.js is a plain
// <script src> file (window/module.exports dual pattern), same as
// range-trainer.js, not a real ES module, so it can't be import()ed directly.
function loadTensionMusic() {
  const sandbox = { window: {}, document: undefined, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.ok(sandbox.window.TensionMusic, "expected tension-music.js to expose window.TensionMusic");
  return sandbox.window.TensionMusic;
}

function state(overrides = {}) {
  return {
    street: "flop",
    complete: false,
    pot: 0,
    players: [],
    ...overrides,
  };
}

test("computeTensionActive is false with no state, no street, or a completed hand - nothing to react to", () => {
  const { computeTensionActive } = loadTensionMusic();
  assert.equal(computeTensionActive(null), false);
  assert.equal(computeTensionActive(undefined), false);
  assert.equal(computeTensionActive(state({ street: "" })), false);
  assert.equal(computeTensionActive(state({ street: "flop", complete: true, pot: 900, players: [{ stack: 100, folded: false }] })), false);
});

test("computeTensionActive is false with no players (an empty/reset table)", () => {
  const { computeTensionActive } = loadTensionMusic();
  assert.equal(computeTensionActive(state({ players: [] })), false);
});

test("computeTensionActive is false for a small pot relative to total chips in play", () => {
  const { computeTensionActive } = loadTensionMusic();
  // Pot is 20, stacks total 980 -> pot is 2% of the 1000 total, nowhere near the threshold.
  const s = state({ pot: 20, players: [{ stack: 490, folded: false }, { stack: 490, folded: false }] });
  assert.equal(computeTensionActive(s), false);
});

test("computeTensionActive is true once the pot reaches the configured fraction of total chips in play", () => {
  const { computeTensionActive, POT_FRACTION_THRESHOLD } = loadTensionMusic();
  // Pot 500, stacks total 500 -> exactly 50%, right at POT_FRACTION_THRESHOLD.
  assert.equal(POT_FRACTION_THRESHOLD, 0.5);
  const atThreshold = state({ pot: 500, players: [{ stack: 250, folded: false }, { stack: 250, folded: false }] });
  assert.equal(computeTensionActive(atThreshold), true);

  const justUnder = state({ pot: 499, players: [{ stack: 250, folded: false }, { stack: 251, folded: false }] });
  assert.equal(computeTensionActive(justUnder), false);
});

test("computeTensionActive is true the instant any live (non-folded) player is all-in, regardless of pot size", () => {
  const { computeTensionActive } = loadTensionMusic();
  const s = state({
    pot: 30, // tiny pot, well under the fraction threshold on its own
    players: [
      { stack: 0, folded: false }, // all-in
      { stack: 970, folded: false },
    ],
  });
  assert.equal(computeTensionActive(s), true);
});

test("computeTensionActive ignores a folded player sitting at 0 - they're out, not all-in", () => {
  const { computeTensionActive } = loadTensionMusic();
  const s = state({
    pot: 30,
    players: [
      { stack: 0, folded: true }, // folded earlier in a prior street, not a current all-in
      { stack: 970, folded: false },
    ],
  });
  assert.equal(computeTensionActive(s), false);
});

test("computeTensionActive treats a table where every remaining player is at 0 total chips as false (nothing to divide by)", () => {
  const { computeTensionActive } = loadTensionMusic();
  const s = state({ pot: 0, players: [{ stack: 0, folded: true }, { stack: 0, folded: true }] });
  assert.equal(computeTensionActive(s), false);
});
