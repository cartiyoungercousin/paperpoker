import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { getCatalogForUser, unlockCosmetic, equipCosmetic, grantTournamentCosmetic, COSMETICS_CATALOG } from "../src/cosmetics.js";

function seedUser(db, coins = 0) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, coins)
    VALUES (?, ?, 'h', 's', ?, ?)
  `).run(`user${Math.random()}@example.com`, "Tester", Date.now(), coins);
  return Number(info.lastInsertRowid);
}

test("catalog defaults (classic card back, green felt) are always owned and equipped without a purchase", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  const catalog = getCatalogForUser(db, userId);

  const classic = catalog.cardBack.find((c) => c.key === "classic");
  const green = catalog.feltColor.find((c) => c.key === "green");
  assert.equal(classic.owned, true);
  assert.equal(classic.equipped, true);
  assert.equal(green.owned, true);
  assert.equal(green.equipped, true);

  const diamond = catalog.cardBack.find((c) => c.key === "diamond");
  assert.equal(diamond.owned, false);
  assert.equal(diamond.equipped, false);
});

test("unlockCosmetic deducts the exact cost and records ownership", () => {
  const db = openDb(":memory:");
  const diamondCost = COSMETICS_CATALOG.cardBack.find((c) => c.key === "diamond").cost;
  const userId = seedUser(db, diamondCost + 50);

  const result = unlockCosmetic(db, userId, "cardBack", "diamond");
  assert.equal(result.ok, true);
  assert.equal(result.coins, 50);

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 50);

  const catalog = getCatalogForUser(db, userId);
  assert.equal(catalog.cardBack.find((c) => c.key === "diamond").owned, true);
});

test("unlockCosmetic refuses when the user doesn't have enough coins, and doesn't deduct anything", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 50);

  const result = unlockCosmetic(db, userId, "cardBack", "diamond");
  assert.equal(result.ok, false);
  assert.match(result.error, /enough coins/i);

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 50, "coins should be untouched on refusal");
});

test("unlockCosmetic refuses a second unlock of something already owned", () => {
  const db = openDb(":memory:");
  const diamondCost = COSMETICS_CATALOG.cardBack.find((c) => c.key === "diamond").cost;
  const userId = seedUser(db, 1000);

  assert.equal(unlockCosmetic(db, userId, "cardBack", "diamond").ok, true);
  const second = unlockCosmetic(db, userId, "cardBack", "diamond");
  assert.equal(second.ok, false);
  assert.match(second.error, /already unlocked/i);

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 1000 - diamondCost, "should not have been double-charged");
});

test("unlockCosmetic refuses an unknown category/key", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 1000);
  assert.equal(unlockCosmetic(db, userId, "cardBack", "nonexistent").ok, false);
  assert.equal(unlockCosmetic(db, userId, "bogusCategory", "classic").ok, false);
});

test("unlockCosmetic refuses to 'unlock' an already-free default item", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 1000);
  const result = unlockCosmetic(db, userId, "cardBack", "classic");
  assert.equal(result.ok, false);
  assert.match(result.error, /already free/i);
});

test("equipCosmetic refuses an item the user doesn't own yet", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  const result = equipCosmetic(db, userId, "cardBack", "diamond");
  assert.equal(result.ok, false);
  assert.match(result.error, /don't own/i);

  const row = db.prepare("SELECT equipped_card_back FROM users WHERE id = ?").get(userId);
  assert.equal(row.equipped_card_back, "classic", "should not have equipped an unowned item");
});

test("equipCosmetic succeeds once owned, and getCatalogForUser reflects the new equipped state", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 1000);

  unlockCosmetic(db, userId, "feltColor", "blue");
  const result = equipCosmetic(db, userId, "feltColor", "blue");
  assert.equal(result.ok, true);

  const catalog = getCatalogForUser(db, userId);
  assert.equal(catalog.feltColor.find((c) => c.key === "blue").equipped, true);
  assert.equal(catalog.feltColor.find((c) => c.key === "green").equipped, false);
});

test("equipCosmetic can always equip a free default item without owning it via unlock", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 1000);
  unlockCosmetic(db, userId, "cardBack", "diamond");
  equipCosmetic(db, userId, "cardBack", "diamond");

  const result = equipCosmetic(db, userId, "cardBack", "classic");
  assert.equal(result.ok, true);
  const row = db.prepare("SELECT equipped_card_back FROM users WHERE id = ?").get(userId);
  assert.equal(row.equipped_card_back, "classic");
});

test("unlockCosmetic returns null for a user id that doesn't exist", () => {
  const db = openDb(":memory:");
  assert.equal(unlockCosmetic(db, 99999, "cardBack", "diamond"), null);
});

test("every catalog category has exactly one free (cost 0) default entry", () => {
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    const frees = COSMETICS_CATALOG[category].filter((c) => c.cost === 0);
    assert.equal(frees.length, 1, `${category} should have exactly one free default`);
  }
});

test("every catalog category offers a real selection - at least 5 items beyond the free default (coin-priced or rank-gated)", () => {
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    const nonFreeOptions = COSMETICS_CATALOG[category].filter((c) => c.cost !== 0);
    assert.ok(nonFreeOptions.length >= 5, `${category} should have a substantial catalog, not just a couple of options`);
  }
});

test("every category mixes coin-priced and rank-gated items - not segregated all-one-or-the-other", () => {
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    const coinPriced = COSMETICS_CATALOG[category].filter((c) => c.cost > 0);
    const rankGated = COSMETICS_CATALOG[category].filter((c) => c.cost === null);
    assert.ok(coinPriced.length > 0, `${category} should have at least one coin-purchasable item`);
    assert.ok(rankGated.length > 0, `${category} should have at least one rank-gated item`);
  }
});

test("every non-free item has a distinct cost, and costs climb rather than repeating/decreasing within a category", () => {
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    const costs = COSMETICS_CATALOG[category].filter((c) => c.cost > 0).map((c) => c.cost);
    assert.equal(new Set(costs).size, costs.length, `${category} should not have two items at the exact same price`);
    const sorted = [...costs].sort((a, b) => a - b);
    assert.deepEqual(costs, sorted, `${category}'s items should already be listed cheapest-to-priciest`);
  }
});

test("every catalog item has a unique key within its category and a non-empty display name", () => {
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    const keys = COSMETICS_CATALOG[category].map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, `${category} should have no duplicate keys`);
    for (const item of COSMETICS_CATALOG[category]) {
      assert.equal(typeof item.name, "string");
      assert.ok(item.name.trim().length > 0);
    }
  }
});

// ===== Rank-gated cosmetics (cost: null) - ownership computed live against
// the permanent highest_rank_tier_index, never a coin purchase =====

test("unlockCosmetic refuses to sell a rank-gated item, even with plenty of coins", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 100000);
  const result = unlockCosmetic(db, userId, "cardBack", "aurora");
  assert.equal(result.ok, false);
  assert.match(result.error, /rank, not coins/i);

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 100000, "no coins should have been touched by the refusal");
});

test("a rank-gated item is not owned below its required tier, and becomes owned (without any purchase) once the tier is reached", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);

  let catalog = getCatalogForUser(db, userId);
  const auroraBefore = catalog.cardBack.find((c) => c.key === "aurora");
  assert.equal(auroraBefore.owned, false);
  assert.equal(typeof auroraBefore.unlockRank, "string", "should show what rank unlocks it");

  // Aurora Shift unlocks at Gold III (tier index 6, see src/rankUnlocks.js).
  db.prepare("UPDATE users SET highest_rank_tier_index = ? WHERE id = ?").run(6, userId);
  catalog = getCatalogForUser(db, userId);
  const auroraAfter = catalog.cardBack.find((c) => c.key === "aurora");
  assert.equal(auroraAfter.owned, true);
  assert.equal(auroraAfter.unlockRank, null, "no need to show the requirement once it's actually owned");
});

test("equipCosmetic refuses a rank-gated item below its required tier, and succeeds once reached", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);

  const tooLow = equipCosmetic(db, userId, "cardBack", "aurora");
  assert.equal(tooLow.ok, false);
  assert.match(tooLow.error, /haven't unlocked/i);

  db.prepare("UPDATE users SET highest_rank_tier_index = ? WHERE id = ?").run(6, userId);
  const nowOk = equipCosmetic(db, userId, "cardBack", "aurora");
  assert.equal(nowOk.ok, true);

  const row = db.prepare("SELECT equipped_card_back FROM users WHERE id = ?").get(userId);
  assert.equal(row.equipped_card_back, "aurora");
});

test("a rank-gated unlock is permanent - it stays owned even if highest_rank_tier_index isn't touched again", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  db.prepare("UPDATE users SET highest_rank_tier_index = ? WHERE id = ?").run(15, userId); // PokerProfessor, the top tier

  const catalog = getCatalogForUser(db, userId);
  // Every rank-gated item in the catalog should read as owned once the top
  // tier has been reached, regardless of category.
  for (const category of Object.keys(COSMETICS_CATALOG)) {
    for (const item of COSMETICS_CATALOG[category]) {
      if (item.cost === null) {
        const entry = catalog[category].find((c) => c.key === item.key);
        assert.equal(entry.owned, true, `${category}:${item.key} should be owned at the top tier`);
      }
    }
  }
});

// ===== Tournament-gated cosmetics (cost: "tournament") - regression coverage
// for a real bug found while adding this sentinel: unlockCosmetic's coin-
// purchase path and equipCosmetic's ownership check both used numeric
// comparisons (`cost < N`, `cost > 0`) that silently misbehave on a string
// cost via NaN coercion - see the comments in src/cosmetics.js for exactly
// what each one used to let through. =====

test("unlockCosmetic refuses to sell a tournament-exclusive item, even with plenty of coins - the coin-corruption bug this closes", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 999999);
  const result = unlockCosmetic(db, userId, "nameFlair", "worldChampion");
  assert.equal(result.ok, false);
  assert.match(result.error, /tournament/i);

  // Before the fix, `row.coins < cosmetic.cost` compared against NaN (always
  // false), so the purchase would have "succeeded" and written NaN into the
  // coins column - confirm the balance is untouched.
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 999999);
});

test("equipCosmetic refuses a tournament-exclusive item the user hasn't won yet - the equip-bypass bug this closes", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  // Before the fix, `cosmetic.cost > 0` was false for the string sentinel
  // too (via NaN coercion) and so was `cosmetic.cost === null` - neither
  // branch fired, so the ownership check was skipped entirely and this
  // would have silently succeeded.
  const result = equipCosmetic(db, userId, "tableTheme", "worldTrophy");
  assert.equal(result.ok, false);
  assert.match(result.error, /don't own/i);

  const catalog = getCatalogForUser(db, userId);
  assert.equal(catalog.tableTheme.find((c) => c.key === "worldTrophy").equipped, false);
});

test("grantTournamentCosmetic grants ownership directly - no coin cost, no rank check - and equipCosmetic then succeeds", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  const result = grantTournamentCosmetic(db, userId, "tableTheme", "worldTrophy");
  assert.equal(result.ok, true);
  assert.equal(result.alreadyOwned, false);

  const catalog = getCatalogForUser(db, userId);
  assert.equal(catalog.tableTheme.find((c) => c.key === "worldTrophy").owned, true);

  const equipResult = equipCosmetic(db, userId, "tableTheme", "worldTrophy");
  assert.equal(equipResult.ok, true);
});

test("grantTournamentCosmetic is idempotent - granting the same item twice doesn't error or duplicate the unlock row", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  grantTournamentCosmetic(db, userId, "nameFlair", "worldChampion");
  const second = grantTournamentCosmetic(db, userId, "nameFlair", "worldChampion");
  assert.equal(second.ok, true);
  assert.equal(second.alreadyOwned, true);

  const rows = db.prepare("SELECT COUNT(*) as c FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?")
    .get(userId, "nameFlair:worldChampion");
  assert.equal(rows.c, 1);
});

test("grantTournamentCosmetic refuses to grant a non-tournament (coin-priced or free) item", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  assert.equal(grantTournamentCosmetic(db, userId, "cardBack", "diamond").ok, false);
  assert.equal(grantTournamentCosmetic(db, userId, "cardBack", "classic").ok, false);
});

test("getCatalogForUser surfaces unlockHint for a locked tournament item, and clears it once granted", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, 0);
  let entry = getCatalogForUser(db, userId).nameFlair.find((c) => c.key === "worldChampion");
  assert.equal(entry.owned, false);
  assert.equal(typeof entry.unlockHint, "string");
  assert.ok(entry.unlockHint.length > 0);
  assert.equal(entry.unlockRank, null, "unlockRank is the rank-gated hint field, should stay null here");

  grantTournamentCosmetic(db, userId, "nameFlair", "worldChampion");
  entry = getCatalogForUser(db, userId).nameFlair.find((c) => c.key === "worldChampion");
  assert.equal(entry.owned, true);
  assert.equal(entry.unlockHint, null, "no hint needed once owned");
});
