import { test } from "node:test";
import assert from "node:assert/strict";
import { RANK_TIERS } from "../src/rankTiers.js";
import {
  RANK_UNLOCKS, tierIndexForXp, isBotUnlockedAtTier, isCosmeticUnlockedAtTier,
  requiredTierIndexForCosmetic, requiredTierIndexForBot,
  coinBonusBetweenTiers, unlocksBetweenTiers,
} from "../src/rankUnlocks.js";

test("RANK_UNLOCKS has exactly one entry per RANK_TIERS index", () => {
  assert.equal(RANK_UNLOCKS.length, RANK_TIERS.length);
});

test("Bronze (tiers 0-2) grants nothing - fast, low-stakes early progress", () => {
  assert.equal(RANK_UNLOCKS[0], null);
  assert.equal(RANK_UNLOCKS[1], null);
  assert.equal(RANK_UNLOCKS[2], null);
});

test("tierIndexForXp resolves the same tier boundaries as rankForXp", () => {
  assert.equal(tierIndexForXp(0), 0);
  assert.equal(tierIndexForXp(149), 0);
  assert.equal(tierIndexForXp(150), 1);
  assert.equal(tierIndexForXp(48500), 15);
  assert.equal(tierIndexForXp(999999), 15, "clamps to the top tier, never overflows");
});

test("tierIndexForXp floors negative/undefined XP at 0", () => {
  assert.equal(tierIndexForXp(-500), 0);
  assert.equal(tierIndexForXp(undefined), 0);
});

test("isBotUnlockedAtTier is false below the required tier and true at/after it", () => {
  const rockRequiredIdx = requiredTierIndexForBot("rock");
  assert.equal(typeof rockRequiredIdx, "number");
  assert.equal(isBotUnlockedAtTier("rock", rockRequiredIdx - 1), false);
  assert.equal(isBotUnlockedAtTier("rock", rockRequiredIdx), true);
  assert.equal(isBotUnlockedAtTier("rock", rockRequiredIdx + 1), true, "reaching a LATER tier keeps it unlocked");
});

test("every one of the 5 experimental bots has a required tier somewhere in RANK_UNLOCKS", () => {
  for (const bot of ["drunk", "bluffer", "rock", "maniac", "boardroom"]) {
    assert.equal(typeof requiredTierIndexForBot(bot), "number", `${bot} should be gated at some tier`);
  }
});

test("requiredTierIndexForBot/Cosmetic return null for something that isn't actually gated", () => {
  assert.equal(requiredTierIndexForBot("not-a-real-bot"), null);
  assert.equal(requiredTierIndexForCosmetic("cardBack", "classic"), null, "the free default isn't rank-gated");
});

test("isCosmeticUnlockedAtTier mirrors isBotUnlockedAtTier for a rank-gated cosmetic", () => {
  const requiredIdx = requiredTierIndexForCosmetic("cardBack", "aurora");
  assert.equal(typeof requiredIdx, "number");
  assert.equal(isCosmeticUnlockedAtTier("cardBack", "aurora", requiredIdx - 1), false);
  assert.equal(isCosmeticUnlockedAtTier("cardBack", "aurora", requiredIdx), true);
});

test("coinBonusBetweenTiers sums every tier crossed, not just the destination tier", () => {
  // Silver III (idx 3) and Silver I (idx 5) both carry a coin bonus -
  // jumping from Bronze I (idx 2) straight to Silver I (idx 5) should pick
  // up both, not just Silver I's.
  const silverIiiBonus = RANK_UNLOCKS[3].coinBonus;
  const silverIBonus = RANK_UNLOCKS[5].coinBonus;
  assert.equal(coinBonusBetweenTiers(2, 5), silverIiiBonus + silverIBonus);
});

test("coinBonusBetweenTiers is 0 for a range with no unlocks in it, and for a no-op range", () => {
  assert.equal(coinBonusBetweenTiers(0, 0), 0);
  assert.equal(coinBonusBetweenTiers(3, 3), 0, "already-at-that-tier, nothing newly crossed");
});

test("unlocksBetweenTiers collects every bot/cosmetic crossed in the range, in tier order", () => {
  const { bots, cosmetics } = unlocksBetweenTiers(2, 5); // crosses Silver III and Silver I
  assert.deepEqual(bots, ["rock", "drunk"]);
  assert.ok(cosmetics.some((c) => c.category === "nameFlair" && c.key === "silver"));
  assert.ok(cosmetics.some((c) => c.category === "rippleColor" && c.key === "violet"));
});

test("unlocksBetweenTiers returns empty arrays, not undefined, when nothing was crossed", () => {
  const { bots, cosmetics } = unlocksBetweenTiers(0, 0);
  assert.deepEqual(bots, []);
  assert.deepEqual(cosmetics, []);
});
