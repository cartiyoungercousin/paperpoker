import { RANK_TIERS } from "./rankTiers.js";

// Tournament mode uses one fixed, immutable table configuration per round,
// the same discipline ranked/rumble already use (src/rankedConfig.js,
// src/rumbleConfig.js) and for the same reason - every competitor plays the
// same stakes/pace regardless of client input. Deliberately NOT deduped
// against RUMBLE_FIXED_SETTINGS even though the numbers happen to match
// today - rankedConfig.js and rumbleConfig.js already independently
// duplicate similar numbers so each mode's balance can drift on its own
// later without cross-contaminating the others.
const TOURNAMENT_FIXED_SETTINGS = {
  numPlayers: 6,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  shotClockSeconds: 30,
  turboMode: false,
  resetBalanceEachHand: false,
};

// Every round is exactly 10 hands - whoever has the strictly most chips once
// hand 10 completes advances (an exact tie does NOT advance, unlike Rumble's
// "co-winners on a tie" stance - real coins are staked here).
const TOURNAMENT_ROUND_HANDS_TOTAL = 10;

// Round difficulty escalates Easy -> Medium -> Hard -> Expert -> Expert
// (again) - round 5's bots use the exact same logic as round 4's, "Master"
// is purely a display label, not a distinct difficulty.
const TOURNAMENT_ROUNDS = [
  { round: 1, difficulty: "easy", label: "Easy" },
  { round: 2, difficulty: "medium", label: "Medium" },
  { round: 3, difficulty: "hard", label: "Hard" },
  { round: 4, difficulty: "expert", label: "Expert" },
  { round: 5, difficulty: "expert", label: "Master" },
];
const TOURNAMENT_ROUNDS_TOTAL = TOURNAMENT_ROUNDS.length;

// The paid entry tiers - entryFee is non-refundable the moment a run starts;
// payout is only ever awarded on a full clean sweep (winning all 5 rounds),
// never for a partial run. Both amounts are coins, always resolved
// server-side from this table - never trusted from client input.
//
// requiredRankTierIndex gates entry behind a permanent rank milestone (index
// into RANK_TIERS, src/rankTiers.js) - null means open to everyone. This
// mirrors src/rankUnlocks.js's rank-gated cosmetics/bots exactly: checked
// against a player's PERMANENT users.highest_rank_tier_index high-water
// mark, never live total_xp, so a later XP dip never re-locks a tier a
// player already qualified for.
const TOURNAMENT_TIERS = [
  { key: "local", name: "Local PaperPoker Competition", entryFee: 10, payout: 50, requiredRankTierIndex: null },
  { key: "state", name: "State PaperPoker Circuit", entryFee: 20, payout: 100, requiredRankTierIndex: null },
  { key: "na", name: "North American PaperPoker Tournament", entryFee: 50, payout: 250, requiredRankTierIndex: 2 }, // Bronze I
  { key: "worldSeries", name: "World Series of PaperPoker", entryFee: 100, payout: 500, requiredRankTierIndex: 5 }, // Silver I
  { key: "highRollers", name: "High-Rollers Tournament", entryFee: 200, payout: 1000, requiredRankTierIndex: 8 }, // Gold I
  { key: "celebrityCasual", name: "Celebrity's Casual Tournament", entryFee: 500, payout: 2500, requiredRankTierIndex: 11 }, // PokerAddict I
  { key: "undergroundTables", name: "Underground Tables Tournament", entryFee: 1000, payout: 5000, requiredRankTierIndex: 14 }, // PokerStar I
];

function findTournamentTier(key) {
  return TOURNAMENT_TIERS.find((t) => t.key === key) || null;
}

function tournamentRoundInfo(roundNumber) {
  return TOURNAMENT_ROUNDS.find((r) => r.round === roundNumber) || null;
}

// The display label of the rank a tier requires ("Bronze I", etc.), or null
// if the tier isn't rank-gated - used to render "Requires <label>" client-side.
function requiredRankLabelForTier(tierKey) {
  const tier = findTournamentTier(tierKey);
  if (!tier || tier.requiredRankTierIndex == null) return null;
  const rankTier = RANK_TIERS[tier.requiredRankTierIndex];
  return rankTier ? rankTier.label : null;
}

// Whether a player whose PERMANENT high-water-mark tier index is
// userTierIndex has met a tier's rank requirement - true for ungated tiers.
// Server-side callers must pass users.highest_rank_tier_index, never a
// live-XP-derived index (see the TOURNAMENT_TIERS comment above).
function isTournamentTierUnlockedAtRank(tierKey, userTierIndex) {
  const tier = findTournamentTier(tierKey);
  if (!tier) return false;
  if (tier.requiredRankTierIndex == null) return true;
  return (userTierIndex || 0) >= tier.requiredRankTierIndex;
}

// Which cosmetic each tier grants on a first clean-sweep win ("firstWin",
// threshold 1) vs. on repeated wins ("veteran", threshold 10) - see
// src/cosmetics.js's COSMETICS_CATALOG for the matching cost:"tournament"
// entries these keys must line up with, and src/sessionRegistry.js's
// _handleTournamentRoundComplete for where these thresholds are actually
// checked (against a live COUNT of past wins for the tier, not a separate
// counter column).
const TOURNAMENT_TIER_REWARDS = {
  local: {
    firstWin: { category: "tableTheme", key: "localTrophy" },
    veteran: { category: "nameFlair", key: "localLegend" },
  },
  state: {
    firstWin: { category: "tableTheme", key: "stateTrophy" },
    veteran: { category: "nameFlair", key: "stateChampion" },
  },
  na: {
    firstWin: { category: "tableTheme", key: "naTrophy" },
    veteran: { category: "nameFlair", key: "nationalHero" },
  },
  worldSeries: {
    firstWin: { category: "tableTheme", key: "worldTrophy" },
    veteran: { category: "nameFlair", key: "worldChampion" },
  },
  highRollers: {
    firstWin: { category: "tableTheme", key: "highRollersTrophy" },
    veteran: { category: "nameFlair", key: "highRoller" },
  },
  celebrityCasual: {
    firstWin: { category: "tableTheme", key: "celebrityTrophy" },
    veteran: { category: "nameFlair", key: "aLister" },
  },
  undergroundTables: {
    firstWin: { category: "tableTheme", key: "undergroundTrophy" },
    veteran: { category: "nameFlair", key: "undergroundLegend" },
  },
};
const TOURNAMENT_VETERAN_WIN_THRESHOLD = 10;

export {
  TOURNAMENT_FIXED_SETTINGS,
  TOURNAMENT_ROUND_HANDS_TOTAL,
  TOURNAMENT_ROUNDS,
  TOURNAMENT_ROUNDS_TOTAL,
  TOURNAMENT_TIERS,
  TOURNAMENT_TIER_REWARDS,
  TOURNAMENT_VETERAN_WIN_THRESHOLD,
  findTournamentTier,
  tournamentRoundInfo,
  requiredRankLabelForTier,
  isTournamentTierUnlockedAtRank,
};
