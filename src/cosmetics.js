// Cosmetics: unlockable customizations across several categories, bought
// with Coins, earned by climbing the rank ladder, or (a third source) won
// through Tournament mode. One item per category is always "owned" for free
// (today's existing default look); everything else either costs coins
// (cost > 0, bought via unlockCosmetic), is rank-gated (cost: null,
// ownership computed live against the player's permanent
// highest-rank-tier-index instead of a coin purchase - see src/rankUnlocks.js
// and users.highest_rank_tier_index in src/db.js), or is tournament-gated
// (cost: "tournament", never purchasable at all - ownership is purely a
// user_unlocks row, written only by grantTournamentCosmetic() when a
// tournament win threshold is crossed; see src/sessionRegistry.js). Every
// non-free item's `cost` is checked with strict equality throughout this
// file specifically so these three kinds never get confused with each other
// (a naive `cost > 0` truthy-style check would silently misfire on the
// string sentinel - see unlockCosmetic/equipCosmetic below). Deliberately a
// mix within most categories, not whole categories segregated one way or the
// other - climbing the ladder, grinding coins, and winning tournaments all
// feel worthwhile.
import { isCosmeticUnlockedAtTier, requiredTierIndexForCosmetic } from "./rankUnlocks.js";
import { RANK_TIERS } from "./rankTiers.js";

const COSMETICS_CATALOG = {
  cardBack: [
    { key: "classic", name: "Classic Blue", cost: 0 },
    { key: "diamond", name: "Diamond Weave", cost: 200 },
    { key: "jewel", name: "Ruby Jewel", cost: 300 },
    { key: "emerald", name: "Emerald Gem", cost: 350 },
    { key: "suits", name: "Suit Marks", cost: 400 },
    { key: "midnight", name: "Midnight Sapphire", cost: 500 },
    { key: "royal", name: "Royal Gold", cost: 600 },
    { key: "prism", name: "Prism Shift", cost: 750 },
    { key: "onyx", name: "Onyx Shadow", cost: 800 },
    { key: "topaz", name: "Topaz Blaze", cost: 850 },
    { key: "opal", name: "Opal Shimmer", cost: 900 },
    { key: "platinum", name: "Platinum Edge", cost: 950 },
    { key: "nebula", name: "Nebula Drift", cost: 1000 },
    { key: "aurora", name: "Aurora Shift", cost: null },
    { key: "celestial", name: "Celestial", cost: null },
  ],
  feltColor: [
    { key: "green", name: "Classic Green", cost: 0 },
    { key: "blue", name: "Royal Blue", cost: 200 },
    { key: "crimson", name: "Crimson", cost: 300 },
    { key: "teal", name: "Deep Teal", cost: 350 },
    { key: "purple", name: "Royal Purple", cost: 400 },
    { key: "black", name: "Obsidian Black", cost: 450 },
    { key: "rose", name: "Rose Quartz", cost: 500 },
    { key: "gold", name: "Champagne Gold", cost: 650 },
    { key: "amber", name: "Amber Glow", cost: 700 },
    { key: "forest", name: "Forest Shadow", cost: 750 },
    { key: "slate", name: "Slate Storm", cost: 800 },
    { key: "magenta", name: "Magenta Rush", cost: 850 },
    { key: "sapphireNight", name: "Sapphire Night", cost: null },
  ],
  // Color of the small ripple that plays when you click a button - purely
  // cosmetic, no gameplay effect.
  rippleColor: [
    { key: "white", name: "Classic White", cost: 0 },
    { key: "gold", name: "Golden Ripple", cost: 150 },
    { key: "crimson", name: "Crimson Ripple", cost: 250 },
    { key: "azure", name: "Azure Ripple", cost: 350 },
    { key: "emerald", name: "Emerald Ripple", cost: 450 },
    { key: "silver", name: "Silver Ripple", cost: 500 },
    { key: "coral", name: "Coral Ripple", cost: 550 },
    { key: "amethyst", name: "Amethyst Ripple", cost: 600 },
    { key: "violet", name: "Violet Ripple", cost: null },
    { key: "rainbow", name: "Prism Ripple", cost: null },
  ],
  // A small colored tag shown next to your display name - the four
  // "veteran" flairs are Tournament mode's rarest reward, granted at 10
  // wins of the matching tier (see src/sessionRegistry.js's
  // grantTournamentCosmetic calls), never purchasable at any price.
  nameFlair: [
    { key: "none", name: "No Flair", cost: 0 },
    { key: "sapphire", name: "Sapphire Flair", cost: 300 },
    { key: "ember", name: "Ember Flair", cost: 500 },
    { key: "jade", name: "Jade Flair", cost: 550 },
    { key: "crimson", name: "Crimson Flair", cost: 600 },
    { key: "silver", name: "Silver Flair", cost: null },
    { key: "gold", name: "Gold Flair", cost: null },
    { key: "addict", name: "PokerAddict Flair", cost: null },
    { key: "star", name: "PokerStar Flair", cost: null },
    { key: "legend", name: "Legend Flair", cost: null },
    { key: "localLegend", name: "Local Legend", cost: "tournament", unlockHint: "Win the Local PaperPoker Competition 10 times" },
    { key: "stateChampion", name: "State Champion", cost: "tournament", unlockHint: "Win the State PaperPoker Circuit 10 times" },
    { key: "nationalHero", name: "National Hero", cost: "tournament", unlockHint: "Win the North American PaperPoker Tournament 10 times" },
    { key: "worldChampion", name: "World Champion", cost: "tournament", unlockHint: "Win the World Series of PaperPoker 10 times" },
    { key: "highRoller", name: "High Roller", cost: "tournament", unlockHint: "Win the High-Rollers Tournament 10 times" },
    { key: "aLister", name: "A-Lister", cost: "tournament", unlockHint: "Win the Celebrity's Casual Tournament 10 times" },
    { key: "undergroundLegend", name: "Underground Legend", cost: "tournament", unlockHint: "Win the Underground Tables Tournament 10 times" },
  ],
  // A pattern overlaid on the table felt, independent of its color - the
  // four "champion's felt" trophies are Tournament mode's first-clear
  // reward, granted the first time a tier is won.
  tableTheme: [
    { key: "plain", name: "Plain Felt", cost: 0 },
    { key: "herringbone", name: "Herringbone Weave", cost: 200 },
    { key: "diamond", name: "Diamond Quilt", cost: 350 },
    { key: "leather", name: "Leather Grain", cost: 500 },
    { key: "marble", name: "Marble Inlay", cost: 550 },
    { key: "mahogany", name: "Mahogany Rail", cost: 600 },
    { key: "starlight", name: "Starlight Dust", cost: null },
    { key: "royalCrest", name: "Royal Crest", cost: null },
    { key: "localTrophy", name: "Local Champion's Felt", cost: "tournament", unlockHint: "Win the Local PaperPoker Competition" },
    { key: "stateTrophy", name: "State Champion's Felt", cost: "tournament", unlockHint: "Win the State PaperPoker Circuit" },
    { key: "naTrophy", name: "Continental Champion's Felt", cost: "tournament", unlockHint: "Win the North American PaperPoker Tournament" },
    { key: "worldTrophy", name: "World Champion's Felt", cost: "tournament", unlockHint: "Win the World Series of PaperPoker" },
    { key: "highRollersTrophy", name: "High Roller's Felt", cost: "tournament", unlockHint: "Win the High-Rollers Tournament" },
    { key: "celebrityTrophy", name: "Celebrity's Felt", cost: "tournament", unlockHint: "Win the Celebrity's Casual Tournament" },
    { key: "undergroundTrophy", name: "Underground Felt", cost: "tournament", unlockHint: "Win the Underground Tables Tournament" },
  ],
  // A brief celebration effect played when you win a hand.
  victoryEffect: [
    { key: "none", name: "No Effect", cost: 0 },
    { key: "confetti", name: "Confetti Burst", cost: 250 },
    { key: "coinShower", name: "Coin Shower", cost: 400 },
    { key: "fireworks", name: "Fireworks", cost: 550 },
    { key: "iceBurst", name: "Ice Burst", cost: 600 },
    { key: "starShower", name: "Star Shower", cost: 650 },
    { key: "lightningStrike", name: "Lightning Strike", cost: 700 },
    { key: "goldenGlow", name: "Golden Glow", cost: null },
    { key: "royalFanfare", name: "Royal Fanfare", cost: null },
  ],
};

// Maps a category to the users-table column its equipped selection lives on.
const CATEGORY_COLUMN = {
  cardBack: "equipped_card_back",
  feltColor: "equipped_felt_color",
  rippleColor: "equipped_ripple_color",
  nameFlair: "equipped_name_flair",
  tableTheme: "equipped_table_theme",
  victoryEffect: "equipped_victory_effect",
};

const DEFAULT_EQUIPPED = {
  cardBack: "classic",
  feltColor: "green",
  rippleColor: "white",
  nameFlair: "none",
  tableTheme: "plain",
  victoryEffect: "none",
};

function findCosmetic(category, key) {
  const list = COSMETICS_CATALOG[category];
  if (!list) return null;
  return list.find((c) => c.key === key) || null;
}

// Full catalog annotated with this user's owned/equipped state - what
// GET /api/cosmetics sends back. A rank-gated item (cost: null) is "owned"
// once the player's permanent highest_rank_tier_index has reached the tier
// that grants it (see src/rankUnlocks.js) - no separate unlock/purchase
// record needed, and immune to a later XP dip since the tier index only
// ever moves up. Not-yet-owned rank-gated items carry an `unlockRank` label
// instead of a price, for the shop to display.
function getCatalogForUser(db, userId) {
  const owned = new Set(
    db
      .prepare("SELECT cosmetic_key FROM user_unlocks WHERE user_id = ?")
      .all(userId)
      .map((r) => r.cosmetic_key)
  );
  const columns = Object.values(CATEGORY_COLUMN).join(", ");
  const row = db
    .prepare(`SELECT coins, highest_rank_tier_index, ${columns} FROM users WHERE id = ?`)
    .get(userId);
  const tierIndex = row ? row.highest_rank_tier_index : 0;
  const equipped = {};
  for (const category of Object.keys(CATEGORY_COLUMN)) {
    equipped[category] = row ? row[CATEGORY_COLUMN[category]] : DEFAULT_EQUIPPED[category];
  }
  const annotate = (category) =>
    COSMETICS_CATALOG[category].map((c) => {
      // cost:"tournament" items need no extra branch here - they're never
      // rank-gated, so ownership already resolves correctly from just the
      // owned.has(...) check (true once grantTournamentCosmetic has written
      // a user_unlocks row for it, same as any coin purchase). unlockHint is
      // purely a catalog-authored display string, surfaced only while locked.
      let itemOwned = c.cost === 0 || owned.has(`${category}:${c.key}`);
      let unlockRank = null;
      if (!itemOwned && c.cost === null) {
        itemOwned = isCosmeticUnlockedAtTier(category, c.key, tierIndex);
        if (!itemOwned) {
          const requiredIdx = requiredTierIndexForCosmetic(category, c.key);
          unlockRank = requiredIdx != null ? RANK_TIERS[requiredIdx].label : null;
        }
      }
      const unlockHint = !itemOwned && c.cost === "tournament" ? c.unlockHint || null : null;
      return { ...c, owned: itemOwned, equipped: equipped[category] === c.key, unlockRank, unlockHint };
    });
  const result = { coins: row ? row.coins : 0 };
  for (const category of Object.keys(CATEGORY_COLUMN)) result[category] = annotate(category);
  return result;
}

// Unlocks a coin-priced cosmetic for userId, deducting coins. Validated
// entirely server-side: category/key must exist, must actually cost coins
// (free defaults don't need "unlocking", and rank-gated items are never
// purchasable - see the cost === null check below), must not already be
// owned, and the user must have enough coins - never trust a client-sent
// claim of any of this.
function unlockCosmetic(db, userId, category, key) {
  const cosmetic = findCosmetic(category, key);
  if (!cosmetic) return { ok: false, error: "Unknown cosmetic." };
  if (cosmetic.cost === 0) return { ok: false, error: "This item is already free." };
  if (cosmetic.cost === null) return { ok: false, error: "This item is unlocked by rank, not coins." };
  if (cosmetic.cost === "tournament") return { ok: false, error: "This item is only unlocked by winning a tournament." };

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

// Equips a cosmetic - must already be owned, either via a coin purchase
// (user_unlocks row) or, for a rank-gated item, by having actually reached
// the tier that grants it (checked live against highest_rank_tier_index,
// same as getCatalogForUser's ownership computation).
function equipCosmetic(db, userId, category, key) {
  const cosmetic = findCosmetic(category, key);
  if (!cosmetic) return { ok: false, error: "Unknown cosmetic." };
  const column = CATEGORY_COLUMN[category];
  if (!column) return { ok: false, error: "Unknown cosmetic." };

  // Ordered as "rank-gated, then everything else non-free" rather than the
  // previous "cost > 0, then null" - cost > 0 is a numeric comparison that
  // silently evaluates false (via NaN coercion) for the "tournament" string
  // sentinel too, which used to skip BOTH branches entirely and let anyone
  // equip a not-yet-earned tournament-exclusive item just by knowing its
  // category/key (freely exposed by the catalog even while locked). Strict
  // equality against null first, then "not free" for anything left (a coin
  // price or "tournament"), closes that gap for both cases uniformly.
  if (cosmetic.cost === null) {
    const row = db.prepare("SELECT highest_rank_tier_index FROM users WHERE id = ?").get(userId);
    if (!row) return null;
    if (!isCosmeticUnlockedAtTier(category, key, row.highest_rank_tier_index)) {
      return { ok: false, error: "You haven't unlocked this yet." };
    }
  } else if (cosmetic.cost !== 0) {
    const unlockKey = `${category}:${key}`;
    const owned = db
      .prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?")
      .get(userId, unlockKey);
    if (!owned) return { ok: false, error: "You don't own this yet." };
  }

  const info = db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(key, userId);
  if (info.changes === 0) return null;
  return { ok: true, category, key };
}

// Grants a cost:"tournament" cosmetic outright - the only way one of these
// is ever owned, called from src/sessionRegistry.js when a tournament win
// crosses a reward threshold. Idempotent (a no-op if already owned) so it's
// safe to call unconditionally every qualifying win rather than only on the
// exact crossing win - self-healing against any bug in an earlier deploy
// that might have missed a grant.
function grantTournamentCosmetic(db, userId, category, key) {
  const cosmetic = findCosmetic(category, key);
  if (!cosmetic || cosmetic.cost !== "tournament") return { ok: false, error: "Not a tournament-exclusive cosmetic." };
  const unlockKey = `${category}:${key}`;
  const already = db
    .prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?")
    .get(userId, unlockKey);
  if (already) return { ok: true, category, key, alreadyOwned: true };
  db.prepare("INSERT INTO user_unlocks (user_id, cosmetic_key, unlocked_at) VALUES (?, ?, ?)").run(
    userId,
    unlockKey,
    Date.now()
  );
  return { ok: true, category, key, alreadyOwned: false };
}

export { COSMETICS_CATALOG, CATEGORY_COLUMN, DEFAULT_EQUIPPED, getCatalogForUser, unlockCosmetic, equipCosmetic, grantTournamentCosmetic };
