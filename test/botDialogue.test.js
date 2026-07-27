import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLine, PERSONA_BANKS, REACTION_LINES } from "../src/botDialogue.js";

const CATEGORIES = ["bigLoss", "bigWin", "caughtBluff", "premiumHand", "banter"];
const ALL_PERSONAS = Object.keys(PERSONA_BANKS);
const LARGE_BANK_PERSONAS = ["sober", "drunk"];

test("every persona bank has all five categories, each with at least a few variations", () => {
  for (const persona of ALL_PERSONAS) {
    for (const category of CATEGORIES) {
      const bank = PERSONA_BANKS[persona][category];
      assert.ok(Array.isArray(bank) && bank.length >= 3, `${persona}.${category} should have several variations`);
    }
  }
});

test("sober and drunk banks are genuinely large (~20+ lines) per category", () => {
  for (const persona of LARGE_BANK_PERSONAS) {
    for (const category of CATEGORIES) {
      assert.ok(
        PERSONA_BANKS[persona][category].length >= 18,
        `${persona}.${category} should have a large bank of variations`
      );
    }
  }
});

test("every line in every persona bank, plus the shared reaction bank, is a non-empty string", () => {
  for (const persona of ALL_PERSONAS) {
    for (const category of CATEGORIES) {
      for (const line of PERSONA_BANKS[persona][category]) {
        assert.equal(typeof line, "string");
        assert.ok(line.trim().length > 0);
      }
    }
  }
  for (const line of REACTION_LINES) {
    assert.equal(typeof line, "string");
    assert.ok(line.trim().length > 0);
  }
});

test("pickLine never returns an empty line for a known category, across every persona", () => {
  for (const persona of ALL_PERSONAS) {
    for (const category of CATEGORIES) {
      for (let i = 0; i < 10; i++) {
        const line = pickLine(category, persona);
        assert.equal(typeof line, "string");
        assert.ok(line.length > 0);
      }
    }
  }
});

test("pickLine returns null for an unrecognized category instead of throwing", () => {
  assert.equal(pickLine("notARealCategory", "sober"), null);
  assert.equal(pickLine(undefined, "drunk"), null);
});

test("pickLine falls back to the sober bank for an unrecognized personaKey", () => {
  const line = pickLine("banter", "totallyMadeUpPersona");
  assert.ok(PERSONA_BANKS.sober.banter.includes(line));
});

test("pickLine defaults to the sober persona when none is given", () => {
  const line = pickLine("banter");
  assert.ok(PERSONA_BANKS.sober.banter.includes(line));
});

test("the sober and drunk banks are entirely disjoint per category - the Drunk gets its own flavor, not a blend", () => {
  for (const category of CATEGORIES) {
    const overlap = PERSONA_BANKS.sober[category].filter((line) => PERSONA_BANKS.drunk[category].includes(line));
    assert.equal(overlap.length, 0, `${category} should not share lines between the sober and Drunk banks`);
  }
});

test("pickLine actually varies across repeated calls (not always the first line)", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pickLine("banter", "sober"));
  assert.ok(seen.size > 1, "expected more than one distinct line across 50 draws");
});

test("pickLine's excludeSet avoids repeating lines already used this hand", () => {
  const used = new Set(PERSONA_BANKS.rock.banter.slice(0, PERSONA_BANKS.rock.banter.length - 1));
  for (let i = 0; i < 20; i++) {
    const line = pickLine("banter", "rock", used);
    assert.equal(line, PERSONA_BANKS.rock.banter[PERSONA_BANKS.rock.banter.length - 1]);
  }
});

test("pickLine allows a repeat once excludeSet covers the entire bank, rather than returning null", () => {
  const used = new Set(PERSONA_BANKS.rock.banter);
  const line = pickLine("banter", "rock", used);
  assert.ok(PERSONA_BANKS.rock.banter.includes(line));
});

test("pickLine('reaction', ...) draws from the shared, persona-agnostic reaction bank regardless of personaKey", () => {
  for (const persona of ["tycoon", "newcomer", "sober"]) {
    const line = pickLine("reaction", persona);
    assert.ok(REACTION_LINES.includes(line));
  }
});

test("every Boardroom character persona exists with a distinct dialogue identity", () => {
  const boardroomPersonas = ["tycoon", "schemer", "conspiracy", "socialite", "veteran", "newcomer"];
  for (const persona of boardroomPersonas) {
    assert.ok(PERSONA_BANKS[persona], `expected a dialogue bank for ${persona}`);
  }
  // Spot-check banter lines are all distinct across characters - each reads
  // as its own voice, not palette-swapped copies of one another.
  const allBanterLines = boardroomPersonas.flatMap((p) => PERSONA_BANKS[p].banter);
  assert.equal(new Set(allBanterLines).size, allBanterLines.length, "expected no duplicate banter lines across Boardroom characters");
});
