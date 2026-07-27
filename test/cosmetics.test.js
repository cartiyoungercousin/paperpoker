import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { getCatalogForUser, unlockCosmetic, equipCosmetic, COSMETICS_CATALOG } from "../src/cosmetics.js";

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
  const userId = seedUser(db, 150);

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
  const userId = seedUser(db, 1000);

  assert.equal(unlockCosmetic(db, userId, "cardBack", "diamond").ok, true);
  const second = unlockCosmetic(db, userId, "cardBack", "diamond");
  assert.equal(second.ok, false);
  assert.match(second.error, /already unlocked/i);

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 900, "should not have been double-charged");
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
