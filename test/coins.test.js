import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { claimDailyReward, hasUnclaimedDailyReward, applyHandCoinsReward, DAILY_REWARD_TABLE, HAND_COINS_REWARD } from "../src/coins.js";

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

test("applyHandCoinsReward adds the flat per-hand amount and accumulates across hands", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Wes");

  const first = applyHandCoinsReward(db, userId);
  assert.equal(first.delta, HAND_COINS_REWARD);
  assert.equal(first.coins, HAND_COINS_REWARD);

  const second = applyHandCoinsReward(db, userId);
  assert.equal(second.coins, HAND_COINS_REWARD * 2);
});

test("applyHandCoinsReward returns null for a user id that doesn't exist", () => {
  const db = openDb(":memory:");
  assert.equal(applyHandCoinsReward(db, 99999), null);
});
