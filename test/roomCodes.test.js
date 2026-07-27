import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRoomCode, generateUniqueRoomCode, CODE_ALPHABET, CODE_LENGTH } from "../src/roomCodes.js";

test("generateRoomCode produces a code of the expected length using only the unambiguous alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `unexpected character ${ch} in code ${code}`);
  }
});

test("generateRoomCode never produces visually-ambiguous characters (0, O, 1, I, L)", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.ok(!/[0O1IL]/.test(code), `code ${code} contained an excluded ambiguous character`);
  }
});

test("generateUniqueRoomCode avoids every code already in the existing set", () => {
  const existing = new Set(["AAAAAA", "BBBBBB"]);
  const code = generateUniqueRoomCode(existing, 20);
  assert.ok(code);
  assert.ok(!existing.has(code));
});

test("generateUniqueRoomCode returns null once every attempt collides", () => {
  const alwaysCollides = { has: () => true };
  assert.equal(generateUniqueRoomCode(alwaysCollides, 3), null);
});
