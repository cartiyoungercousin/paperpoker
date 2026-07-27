import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { claimDailyReward, hasUnclaimedDailyReward, applyHandCoinsReward, computeHandCoinsDelta, DAILY_REWARD_TABLE, HAND_COINS_REWARD, WIN_STREAK_BONUS_THRESHOLD } from "../src/coins.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedUser(db, displayName) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
    VALUES (?, ?, 'x', 'x', 0)
  `).run(displayName.toLowerCase() + "@example.com", displayName);
  return Number(info.lastInsertRowid);
}

// Backdates the user's last claim by daysAgo real days, so the next
// claimDailyReward() call sees it as having happened that long ago -
// standard technique for testing day-boundary logic without faking Date.now.
function backdateLastClaim(db, userId, daysAgo) {
  db.prepare("UPDATE users SET last_daily_reward_at = ? WHERE id = ?").run(Date.now() - daysAgo * DAY_MS, userId);
}

test("claimDailyReward returns null for a user id that doesn't exist", () => {
  const db = openDb(":memory:");
  assert.equal(claimDailyReward(db, 99999), null);
});

test("a first-ever claim starts the streak at day 1 and awards the day-1 amount", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Priya");

  const result = claimDailyReward(db, userId);
  assert.equal(result.claimed, true);
  assert.equal(result.streakDay, 1);
  assert.equal(result.streakDays, 1);
  assert.equal(result.amount, DAILY_REWARD_TABLE[0]);
  assert.equal(result.coins, DAILY_REWARD_TABLE[0]);

  const row = db.prepare("SELECT coins, login_streak_days FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, DAILY_REWARD_TABLE[0]);
  assert.equal(row.login_streak_days, 1);
});

test("claiming again the same day is refused and does not award coins twice", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Quinn");

  const first = claimDailyReward(db, userId);
  const second = claimDailyReward(db, userId);

  assert.equal(second.claimed, false);
  assert.equal(second.alreadyClaimedToday, true);
  assert.equal(second.coins, first.coins, "no additional coins from the refused second claim");
});

test("claiming on the very next UTC day continues the streak and awards the day-2 amount", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "River");

  claimDailyReward(db, userId);
  backdateLastClaim(db, userId, 1);
  const second = claimDailyReward(db, userId);

  assert.equal(second.claimed, true);
  assert.equal(second.streakDay, 2);
  assert.equal(second.streakDays, 2);
  assert.equal(second.amount, DAILY_REWARD_TABLE[1]);
});

test("a gap of more than one day resets the streak back to day 1, not just continuing", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Sam");

  claimDailyReward(db, userId);
  backdateLastClaim(db, userId, 1);
  claimDailyReward(db, userId); // now on a 2-day streak

  backdateLastClaim(db, userId, 5); // skipped several days
  const afterGap = claimDailyReward(db, userId);

  assert.equal(afterGap.streakDay, 1);
  assert.equal(afterGap.streakDays, 1, "the real streak counter also resets, not just the display day");
  assert.equal(afterGap.amount, DAILY_REWARD_TABLE[0]);
});

test("the reward table cycles after day 7 - day 8 pays the day-1 amount again, but the real streak keeps counting up", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Tam");

  let last;
  for (let day = 1; day <= 8; day++) {
    if (day > 1) backdateLastClaim(db, userId, 1);
    last = claimDailyReward(db, userId);
  }

  assert.equal(last.streakDays, 8, "8 real consecutive days");
  assert.equal(last.streakDay, 1, "cycles back to the day-1 slot in the 7-day table");
  assert.equal(last.amount, DAILY_REWARD_TABLE[0]);
});

test("day 7 pays out the configured bigger jump", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Uma");

  let last;
  for (let day = 1; day <= 7; day++) {
    if (day > 1) backdateLastClaim(db, userId, 1);
    last = claimDailyReward(db, userId);
  }

  assert.equal(last.streakDay, 7);
  assert.equal(last.amount, DAILY_REWARD_TABLE[6]);
  assert.ok(DAILY_REWARD_TABLE[6] > DAILY_REWARD_TABLE[5], "day 7 should be a bigger jump than a straight ramp");
});

test("hasUnclaimedDailyReward reflects claim state correctly across day boundaries", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Val");

  assert.equal(hasUnclaimedDailyReward(db, userId), true, "never claimed yet");
  claimDailyReward(db, userId);
  assert.equal(hasUnclaimedDailyReward(db, userId), false, "just claimed today");

  backdateLastClaim(db, userId, 1);
  assert.equal(hasUnclaimedDailyReward(db, userId), true, "a new day has started");
});

test("hasUnclaimedDailyReward returns false rather than throwing for an unknown user", () => {
  const db = openDb(":memory:");
  assert.equal(hasUnclaimedDailyReward(db, 99999), false);
});

test("applyHandCoinsReward applies the given delta and accumulates across hands", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Wes");

  const first = applyHandCoinsReward(db, userId, HAND_COINS_REWARD);
  assert.equal(first.delta, HAND_COINS_REWARD);
  assert.equal(first.coins, HAND_COINS_REWARD);

  const second = applyHandCoinsReward(db, userId, HAND_COINS_REWARD);
  assert.equal(second.coins, HAND_COINS_REWARD * 2);
});

test("applyHandCoinsReward returns null for a user id that doesn't exist", () => {
  const db = openDb(":memory:");
  assert.equal(applyHandCoinsReward(db, 99999, HAND_COINS_REWARD), null);
});

test("applyHandCoinsReward floors at 0 rather than going negative, and returns the actual (smaller) delta applied", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Nadia");
  applyHandCoinsReward(db, userId, 1); // starts at 1 coin

  const result = applyHandCoinsReward(db, userId, -5);
  assert.equal(result.coins, 0, "should floor at 0, not go negative");
  assert.equal(result.delta, -1, "actual delta should reflect the real change (1 -> 0), not the requested -5");
});

test("applyHandCoinsReward applies a negative delta normally when there's enough balance to absorb it", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Omar");
  applyHandCoinsReward(db, userId, 10);

  const result = applyHandCoinsReward(db, userId, -1);
  assert.equal(result.coins, 9);
  assert.equal(result.delta, -1);
});

// ===== computeHandCoinsDelta: unranked/experimental win-size + streak tiers =====

test("computeHandCoinsDelta charges a flat -1 for any hand you didn't come out ahead on, regardless of how much you lost", () => {
  assert.deepEqual(computeHandCoinsDelta({ netThisHand: -500, startingStack: 1000 }), { delta: -1, tier: "loss", streakBonus: 0 });
  assert.deepEqual(computeHandCoinsDelta({ netThisHand: -1, startingStack: 1000 }), { delta: -1, tier: "loss", streakBonus: 0 });
  assert.deepEqual(computeHandCoinsDelta({ netThisHand: 0, startingStack: 1000 }), { delta: -1, tier: "loss", streakBonus: 0 }, "breaking exactly even is not a win");
});

test("computeHandCoinsDelta pays +1 for a small win, below the big-win threshold", () => {
  const result = computeHandCoinsDelta({ netThisHand: 100, startingStack: 1000 }); // 10% of stack
  assert.equal(result.delta, 1);
  assert.equal(result.tier, "win");
});

test("computeHandCoinsDelta pays +2 for a big win (20%+ of the starting stack)", () => {
  const result = computeHandCoinsDelta({ netThisHand: 250, startingStack: 1000 }); // 25%
  assert.equal(result.delta, 2);
  assert.equal(result.tier, "bigWin");
});

test("computeHandCoinsDelta pays +3 for a massive win (50%+ of the starting stack)", () => {
  const result = computeHandCoinsDelta({ netThisHand: 600, startingStack: 1000 }); // 60%
  assert.equal(result.delta, 3);
  assert.equal(result.tier, "massiveWin");
});

test("computeHandCoinsDelta tier boundaries are inclusive at exactly 20% and 50%", () => {
  assert.equal(computeHandCoinsDelta({ netThisHand: 200, startingStack: 1000 }).tier, "bigWin");
  assert.equal(computeHandCoinsDelta({ netThisHand: 500, startingStack: 1000 }).tier, "massiveWin");
});

test(`computeHandCoinsDelta adds a streak bonus equal to the streak once it reaches ${WIN_STREAK_BONUS_THRESHOLD}, on top of the win-tier amount`, () => {
  const noBonusYet = computeHandCoinsDelta({ netThisHand: 100, startingStack: 1000, winStreak: WIN_STREAK_BONUS_THRESHOLD - 1 });
  assert.equal(noBonusYet.streakBonus, 0);
  assert.equal(noBonusYet.delta, 1);

  const withBonus = computeHandCoinsDelta({ netThisHand: 100, startingStack: 1000, winStreak: WIN_STREAK_BONUS_THRESHOLD });
  assert.equal(withBonus.streakBonus, WIN_STREAK_BONUS_THRESHOLD);
  assert.equal(withBonus.delta, 1 + WIN_STREAK_BONUS_THRESHOLD);

  const longerStreak = computeHandCoinsDelta({ netThisHand: 600, startingStack: 1000, winStreak: 5 });
  assert.equal(longerStreak.streakBonus, 5);
  assert.equal(longerStreak.delta, 3 + 5, "massive-win tier amount plus the streak bonus");
});

test("computeHandCoinsDelta never applies a streak bonus on a loss, even if winStreak is stale/nonzero", () => {
  const result = computeHandCoinsDelta({ netThisHand: -50, startingStack: 1000, winStreak: 5 });
  assert.equal(result.delta, -1);
  assert.equal(result.streakBonus, 0);
});

test("computeHandCoinsDelta treats a negative winStreak (a losing streak) as no bonus", () => {
  const result = computeHandCoinsDelta({ netThisHand: 100, startingStack: 1000, winStreak: -4 });
  assert.equal(result.streakBonus, 0);
  assert.equal(result.delta, 1);
});
