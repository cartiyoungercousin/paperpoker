import { test } from "node:test";
import assert from "node:assert/strict";
import { RANK_TIERS } from "../src/rankTiers.js";
import {
  TOURNAMENT_TIERS, TOURNAMENT_TIER_REWARDS, findTournamentTier,
  requiredRankLabelForTier, isTournamentTierUnlockedAtRank,
} from "../src/tournamentConfig.js";

test("every requiredRankTierIndex is either null or a valid RANK_TIERS index", () => {
  for (const tier of TOURNAMENT_TIERS) {
    if (tier.requiredRankTierIndex == null) continue;
    assert.ok(
      tier.requiredRankTierIndex >= 0 && tier.requiredRankTierIndex < RANK_TIERS.length,
      `${tier.key}'s requiredRankTierIndex (${tier.requiredRankTierIndex}) is out of RANK_TIERS bounds`
    );
  }
});

test("Local and State are open to everyone - no rank requirement", () => {
  assert.equal(findTournamentTier("local").requiredRankTierIndex, null);
  assert.equal(findTournamentTier("state").requiredRankTierIndex, null);
});

test("the escalating tiers require the exact ranks requested: Bronze I, Silver I, Gold I, PokerAddict I, PokerStar I", () => {
  assert.equal(RANK_TIERS[findTournamentTier("na").requiredRankTierIndex].label, "Bronze I");
  assert.equal(RANK_TIERS[findTournamentTier("worldSeries").requiredRankTierIndex].label, "Silver I");
  assert.equal(RANK_TIERS[findTournamentTier("highRollers").requiredRankTierIndex].label, "Gold I");
  assert.equal(RANK_TIERS[findTournamentTier("celebrityCasual").requiredRankTierIndex].label, "PokerAddict I");
  assert.equal(RANK_TIERS[findTournamentTier("undergroundTables").requiredRankTierIndex].label, "PokerStar I");
});

test("the 3 new tiers have the exact entry fee / payout amounts requested", () => {
  const hr = findTournamentTier("highRollers");
  assert.equal(hr.entryFee, 200);
  assert.equal(hr.payout, 1000);
  const cc = findTournamentTier("celebrityCasual");
  assert.equal(cc.entryFee, 500);
  assert.equal(cc.payout, 2500);
  const ut = findTournamentTier("undergroundTables");
  assert.equal(ut.entryFee, 1000);
  assert.equal(ut.payout, 5000);
});

test("requiredRankLabelForTier returns null for an ungated tier and the real label for a gated one", () => {
  assert.equal(requiredRankLabelForTier("local"), null);
  assert.equal(requiredRankLabelForTier("na"), "Bronze I");
});

test("requiredRankLabelForTier returns null for an unknown tier key rather than throwing", () => {
  assert.equal(requiredRankLabelForTier("nope"), null);
});

test("isTournamentTierUnlockedAtRank is always true for an ungated tier, regardless of rank index", () => {
  assert.equal(isTournamentTierUnlockedAtRank("local", 0), true);
  assert.equal(isTournamentTierUnlockedAtRank("state", 0), true);
});

test("isTournamentTierUnlockedAtRank is false below the required index and true at/after it", () => {
  const requiredIdx = findTournamentTier("na").requiredRankTierIndex;
  assert.equal(isTournamentTierUnlockedAtRank("na", requiredIdx - 1), false);
  assert.equal(isTournamentTierUnlockedAtRank("na", requiredIdx), true);
  assert.equal(isTournamentTierUnlockedAtRank("na", requiredIdx + 1), true, "reaching a LATER tier keeps it unlocked, same permanent high-water-mark convention as rankUnlocks.js");
});

test("isTournamentTierUnlockedAtRank treats a null/undefined user tier index as 0 (a brand-new account) rather than throwing", () => {
  assert.equal(isTournamentTierUnlockedAtRank("na", null), false);
  assert.equal(isTournamentTierUnlockedAtRank("na", undefined), false);
  assert.equal(isTournamentTierUnlockedAtRank("local", null), true);
});

test("isTournamentTierUnlockedAtRank is false for an unknown tier key", () => {
  assert.equal(isTournamentTierUnlockedAtRank("nope", 15), false);
});

test("every tier has a TOURNAMENT_TIER_REWARDS entry with firstWin/veteran cosmetics", () => {
  for (const tier of TOURNAMENT_TIERS) {
    const rewards = TOURNAMENT_TIER_REWARDS[tier.key];
    assert.ok(rewards, `${tier.key} is missing a TOURNAMENT_TIER_REWARDS entry`);
    assert.ok(rewards.firstWin.category && rewards.firstWin.key);
    assert.ok(rewards.veteran.category && rewards.veteran.key);
  }
});

test("no two tiers share a reward cosmetic key within the same category", () => {
  const seen = new Set();
  for (const rewards of Object.values(TOURNAMENT_TIER_REWARDS)) {
    for (const grant of [rewards.firstWin, rewards.veteran]) {
      const id = grant.category + ":" + grant.key;
      assert.ok(!seen.has(id), `duplicate reward cosmetic ${id}`);
      seen.add(id);
    }
  }
});
