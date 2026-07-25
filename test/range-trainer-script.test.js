import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.join(__dirname, "..", "range-trainer.js");
const code = fs.readFileSync(scriptPath, "utf8");

test("range-trainer.js parses without syntax errors", () => {
  new Function(code);
});

// Loaded in a sandboxed vm context (no DOM) to inspect the generated range
// data directly - this is exactly where a hand-authored 169-entry table
// would typically break: a missing key, a stray typo, an invalid action.
function loadRangeTrainer() {
  const sandbox = { window: {}, document: undefined, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.ok(sandbox.window.RangeTrainer, "expected range-trainer.js to expose window.RangeTrainer");
  return sandbox.window.RangeTrainer;
}

test("every scenario/position bucket covers all 169 canonical hands with a valid action", () => {
  const { RANGE_DATA, POSITIONS, SCENARIOS } = loadRangeTrainer();
  const validActions = new Set(["fold", "call", "raise"]);

  for (const scenario of SCENARIOS) {
    for (const position of POSITIONS) {
      const table = RANGE_DATA[scenario][position];
      assert.ok(table, `missing range table for ${scenario}/${position}`);
      const keys = Object.keys(table);
      assert.equal(keys.length, 169, `${scenario}/${position} should cover all 169 hands, found ${keys.length}`);
      for (const key of keys) {
        const entry = table[key];
        assert.ok(validActions.has(entry.action), `${scenario}/${position}/${key} has an invalid action: ${entry.action}`);
        if (entry.altAction !== null) {
          assert.ok(validActions.has(entry.altAction), `${scenario}/${position}/${key} has an invalid altAction: ${entry.altAction}`);
        }
      }
    }
  }
});

test("RFI never assigns 'call' (there's no bet to call when unopened)", () => {
  const { RANGE_DATA, POSITIONS } = loadRangeTrainer();
  for (const position of POSITIONS) {
    const table = RANGE_DATA.RFI[position];
    for (const [key, entry] of Object.entries(table)) {
      assert.notEqual(entry.action, "call", `RFI/${position}/${key} should never be a 'call'`);
    }
  }
});

test("sanity-checks obvious hands: AA always raises, 72o always folds (RFI, every position)", () => {
  const { RANGE_DATA, POSITIONS } = loadRangeTrainer();
  for (const position of POSITIONS) {
    assert.equal(RANGE_DATA.RFI[position]["AA"].action, "raise", `AA should raise from ${position}`);
    assert.equal(RANGE_DATA.RFI[position]["72o"].action, "fold", `72o should fold from ${position}`);
  }
});

test("chenScore matches known reference values", () => {
  const { chenScore } = loadRangeTrainer();
  assert.equal(chenScore(14, 14, false), 20); // AA: the max possible score
  assert.equal(chenScore(14, 13, true), 12); // AKs
  assert.equal(chenScore(7, 2, false), 0); // 72o: famously the worst hand, floored at 0
});

test("wider positions open a strictly wider (or equal) range than tighter positions", () => {
  const { RANGE_DATA, POSITIONS } = loadRangeTrainer();
  const raiseCount = (position) => Object.values(RANGE_DATA.RFI[position]).filter((e) => e.action === "raise").length;
  const early = raiseCount("Early");
  const middle = raiseCount("Middle");
  const late = raiseCount("Late");
  const blinds = raiseCount("Blinds");
  assert.ok(early <= middle, "Middle should open at least as wide as Early");
  assert.ok(middle <= late, "Late should open at least as wide as Middle");
  assert.ok(late <= blinds, "Blinds (SB open) should open at least as wide as Late");
});
