// Cosmetics: pure-CSS unlockable customizations bought with Coins - card
// backs and table felt colors. One item per category is always "owned" for
// free (today's existing default look); everything else costs coins and
// must be unlocked before it can be equipped. Establishes the reusable
// spend-validation pattern Rumble mode's eventual entry cost will reuse.

const COSMETICS_CATALOG = {
  cardBack: [
    { key: "classic", name: "Classic Blue", cost: 0 },
    { key: "diamond", name: "Diamond Weave", cost: 100 },
    { key: "jewel", name: "Ruby Jewel", cost: 150 },
    { key: "suits", name: "Suit Marks", cost: 200 },
  ],
  feltColor: [
    { key: "green", name: "Classic Green", cost: 0 },
    { key: "blue", name: "Royal Blue", cost: 100 },
    { key: "crimson", name: "Crimson", cost: 150 },
    { key: "purple", name: "Royal Purple", cost: 200 },
  ],
};

const DEFAULT_EQUIPPED = { cardBack: "classic", feltColor: "green" };

function findCosmetic(category, key) {
  const list = COSMETICS_CATALOG[category];
  if (!list) return null;
  return list.find((c) => c.key === key) || null;
}

// Full catalog annotated with this user's owned/equipped state - what
// GET /api/cosmetics sends back.
function getCatalogForUser(db, userId) {
  const owned = new Set(
    db
      .prepare("SELECT cosmetic_key FROM user_unlocks WHERE user_id = ?")
      .all(userId)
      .map((r) => r.cosmetic_key)
  );
  const row = db
    .prepare("SELECT coins, equipped_card_back, equipped_felt_color FROM users WHERE id = ?")
    .get(userId);
  const equipped = {
    cardBack: row ? row.equipped_card_back : DEFAULT_EQUIPPED.cardBack,
    feltColor: row ? row.equipped_felt_color : DEFAULT_EQUIPPED.feltColor,
  };
  const annotate = (category) =>
    COSMETICS_CATALOG[category].map((c) => ({
      ...c,
      owned: c.cost === 0 || owned.has(`${category}:${c.key}`),
      equipped: equipped[category] === c.key,
    }));
  return {
    coins: row ? row.coins : 0,
    cardBack: annotate("cardBack"),
    feltColor: annotate("feltColor"),
  };
}

// Unlocks a cosmetic for userId, deducting coins. Validated entirely
// server-side: category/key must exist, must actually cost something (free
// defaults don't need "unlocking"), must not already be owned, and the user
// must have enough coins - never trust a client-sent claim of any of this.
function unlockCosmetic(db, userId, category, key) {
  const cosmetic = findCosmetic(category, key);
  if (!cosmetic) return { ok: false, error: "Unknown cosmetic." };
  if (cosmetic.cost === 0) return { ok: false, error: "This item is already free." };

  const unlockKey = `${category}:${key}`;
  const already = db
    .prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?")
    .get(userId, unlockKey);
  if (already) return { ok: false, error: "Already unlocked." };

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  if (row.coins < cosmetic.cost) return { ok: false, error: "Not enough coins." };

  const newCoins = row.coins - cosmetic.cost;
  db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(newCoins, userId);
  db.prepare("INSERT INTO user_unlocks (user_id, cosmetic_key, unlocked_at) VALUES (?, ?, ?)").run(
    userId,
    unlockKey,
    Date.now()
  );

  return { ok: true, coins: newCoins, category, key };
}

// Equips a cosmetic - must already be owned (free defaults are always
// considered owned without a purchase).
function equipCosmetic(db, userId, category, key) {
  const cosmetic = findCosmetic(category, key);
  if (!cosmetic) return { ok: false, error: "Unknown cosmetic." };

  if (cosmetic.cost > 0) {
    const unlockKey = `${category}:${key}`;
    const owned = db
      .prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?")
      .get(userId, unlockKey);
    if (!owned) return { ok: false, error: "You don't own this yet." };
  }

  const column = category === "cardBack" ? "equipped_card_back" : "equipped_felt_color";
  const info = db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(key, userId);
  if (info.changes === 0) return null;
  return { ok: true, category, key };
}

export { COSMETICS_CATALOG, DEFAULT_EQUIPPED, getCatalogForUser, unlockCosmetic, equipCosmetic };
