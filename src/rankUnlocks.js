import { RANK_TIERS } from "./rankTiers.js";

// What gets granted the moment a player's rank first reaches each tier
// (indices line up 1:1 with RANK_TIERS). Bronze grants nothing - fast, easy
// early progress shouldn't feel like a reward treadmill yet; the first real
// unlock lands at Silver III. A tier can grant a coin bonus, one or more
// experimental bot personalities, and/or one or more cosmetics (see
// src/cosmetics.js's COSMETICS_CATALOG for the matching cost:null entries -
// these two files must stay in sync by hand).
//
// Reaching a tier is permanent (see users.highest_rank_tier_index in
// src/db.js) - a later XP dip from a rough ranked session never re-locks
// something already earned, and unlock/ownership checks everywhere key off
// that persisted high-water mark, never off live total_xp.
const RANK_UNLOCKS = [
  null, // Bronze III
  null, // Bronze II
  null, // Bronze I
  { coinBonus: 60, unlockBots: ["rock"] }, // Silver III
  null, // Silver II
  { coinBonus: 100, unlockBots: ["drunk"], cosmetics: [{ category: "nameFlair", key: "silver" }, { category: "rippleColor", key: "violet" }] }, // Silver I
  { coinBonus: 125, cosmetics: [{ category: "cardBack", key: "aurora" }] }, // Gold III
  { coinBonus: 150, unlockBots: ["bluffer"] }, // Gold II
  { coinBonus: 175, cosmetics: [{ category: "nameFlair", key: "gold" }, { category: "tableTheme", key: "starlight" }] }, // Gold I
  { coinBonus: 200, cosmetics: [{ category: "feltColor", key: "sapphireNight" }] }, // PokerAddict III
  { coinBonus: 225, unlockBots: ["maniac"] }, // PokerAddict II
  { coinBonus: 250, cosmetics: [{ category: "nameFlair", key: "addict" }, { category: "victoryEffect", key: "goldenGlow" }] }, // PokerAddict I
  { coinBonus: 300, cosmetics: [{ category: "cardBack", key: "celestial" }] }, // PokerStar III
  { coinBonus: 350, unlockBots: ["boardroom"] }, // PokerStar II
  { coinBonus: 400, cosmetics: [{ category: "nameFlair", key: "star" }, { category: "tableTheme", key: "royalCrest" }] }, // PokerStar I
  { coinBonus: 750, cosmetics: [{ category: "nameFlair", key: "legend" }, { category: "rippleColor", key: "rainbow" }, { category: "victoryEffect", key: "royalFanfare" }] }, // PokerProfessor
];

// Which RANK_TIERS index a given total-XP value has reached - same
// threshold-scan rankForXp() uses, but returning the raw index rather than
// the display shape, since unlock checks only ever need to compare indices.
function tierIndexForXp(totalXp) {
  const safeXp = Math.max(0, totalXp || 0);
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if (RANK_TIERS[i].threshold <= safeXp) idx = i;
    else break;
  }
  return idx;
}

// Whether botKey was unlocked at or before the given (permanent, persisted)
// tier index - used both to gate starting a game with an experimental bot
// server-side, and to render locked/unlocked state client-side.
function isBotUnlockedAtTier(botKey, tierIndex) {
  for (let i = 0; i <= tierIndex && i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (unlock && unlock.unlockBots && unlock.unlockBots.includes(botKey)) return true;
  }
  return false;
}

// Whether a rank-gated cosmetic (category/key) was unlocked at or before the
// given tier index.
function isCosmeticUnlockedAtTier(category, key, tierIndex) {
  for (let i = 0; i <= tierIndex && i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (unlock && unlock.cosmetics && unlock.cosmetics.some((c) => c.category === category && c.key === key)) return true;
  }
  return false;
}

// The tier index a rank-gated cosmetic requires, for "Unlocks at <label>"
// display - null if it isn't actually rank-gated (or doesn't exist).
function requiredTierIndexForCosmetic(category, key) {
  for (let i = 0; i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (unlock && unlock.cosmetics && unlock.cosmetics.some((c) => c.category === category && c.key === key)) return i;
  }
  return null;
}

// Same, for an experimental bot personality - null if it isn't gated (or
// doesn't exist, though today every experimental bot is gated at some tier).
function requiredTierIndexForBot(botKey) {
  for (let i = 0; i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (unlock && unlock.unlockBots && unlock.unlockBots.includes(botKey)) return i;
  }
  return null;
}

// Sums every coin bonus for tiers strictly after fromIdx through toIdx
// inclusive - covers an ordinary single-tier promotion as well as a big XP
// swing (or ranked catch-up) that crosses several tiers in one hand.
function coinBonusBetweenTiers(fromIdx, toIdx) {
  let total = 0;
  for (let i = fromIdx + 1; i <= toIdx && i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (unlock && unlock.coinBonus) total += unlock.coinBonus;
  }
  return total;
}

// Every bot/cosmetic newly granted crossing from fromIdx (exclusive) through
// toIdx (inclusive) - used to build the "you unlocked..." announcement.
function unlocksBetweenTiers(fromIdx, toIdx) {
  const bots = [];
  const cosmetics = [];
  for (let i = fromIdx + 1; i <= toIdx && i < RANK_UNLOCKS.length; i++) {
    const unlock = RANK_UNLOCKS[i];
    if (!unlock) continue;
    if (unlock.unlockBots) bots.push(...unlock.unlockBots);
    if (unlock.cosmetics) cosmetics.push(...unlock.cosmetics);
  }
  return { bots, cosmetics };
}

export {
  RANK_UNLOCKS,
  tierIndexForXp,
  isBotUnlockedAtTier,
  isCosmeticUnlockedAtTier,
  requiredTierIndexForCosmetic,
  requiredTierIndexForBot,
  coinBonusBetweenTiers,
  unlocksBetweenTiers,
};
