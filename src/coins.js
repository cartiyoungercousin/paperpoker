// Coins: a persistent, account-tied currency separate from both in-hand chip
// stacks (which reset every hand/session) and ranked XP (which tracks skill
// progression, not engagement). Earned two ways - a daily login streak
// bonus, and a small reward for simply playing hands - and spent in the
// cosmetics shop (src/cosmetics.js).

// Day boundaries are plain UTC calendar days, same rolling-window approach
// already used for the weekly leaderboard - floor-dividing by a day's worth
// of milliseconds turns "is this a new day" / "was the last claim exactly
// yesterday" into simple integer comparisons, no timezone/DST edge cases.
const DAY_MS = 24 * 60 * 60 * 1000;
function utcDayNumber(ms) {
  return Math.floor(ms / DAY_MS);
}

// Day 7 is a deliberately bigger jump than a straight-line ramp would give -
// a reason to come back and finish the week, not just show up once. Cycles
// back to day 1 on day 8 rather than capping, so a long-running streak keeps
// paying out at the day-7 rate every seventh day indefinitely.
const DAILY_REWARD_TABLE = [10, 15, 20, 25, 30, 35, 50];

// Flat reward for simply being dealt into a hand while logged in, any game
// mode - rewards playing in general, not just ranked or any one mode.
const HAND_COINS_REWARD = 2;

// Claims today's daily-login reward for userId, if it hasn't been claimed
// yet today. Returns null only if userId doesn't resolve to a real user;
// otherwise always returns a result describing what happened (claimed or
// already-claimed), never throws for the "nothing to do" case.
function claimDailyReward(db, userId) {
  const row = db.prepare("SELECT coins, login_streak_days, last_daily_reward_at FROM users WHERE id = ?").get(userId);
  if (!row) return null;

  const now = Date.now();
  const today = utcDayNumber(now);
  const lastDay = row.last_daily_reward_at != null ? utcDayNumber(row.last_daily_reward_at) : null;

  if (lastDay === today) {
    const currentStreakDay = row.login_streak_days > 0 ? ((row.login_streak_days - 1) % 7) + 1 : 0;
    return { claimed: false, alreadyClaimedToday: true, coins: row.coins, streakDay: currentStreakDay, streakDays: row.login_streak_days };
  }

  // A gap of more than one day (or no prior claim at all) resets the streak
  // to day 1 rather than continuing where it left off.
  const isConsecutive = lastDay !== null && today === lastDay + 1;
  const newStreakDays = isConsecutive ? row.login_streak_days + 1 : 1;
  const streakDay = ((newStreakDays - 1) % 7) + 1; // 1..7, cycling regardless of how long the real streak has run
  const amount = DAILY_REWARD_TABLE[streakDay - 1];
  const newCoins = row.coins + amount;

  db.prepare("UPDATE users SET coins = ?, login_streak_days = ?, last_daily_reward_at = ? WHERE id = ?")
    .run(newCoins, newStreakDays, now, userId);

  return { claimed: true, amount, streakDay, streakDays: newStreakDays, coins: newCoins };
}

// Whether userId still has an unclaimed daily reward waiting right now -
// read-only, used by GET /api/me so the client knows to show the claim
// popup without claiming anything itself.
function hasUnclaimedDailyReward(db, userId) {
  const row = db.prepare("SELECT last_daily_reward_at FROM users WHERE id = ?").get(userId);
  if (!row) return false;
  if (row.last_daily_reward_at == null) return true;
  return utcDayNumber(row.last_daily_reward_at) !== utcDayNumber(Date.now());
}

// The small per-hand reward - mirrors applyXpDelta's shape (src/auth.js).
function applyHandCoinsReward(db, userId) {
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  const newCoins = row.coins + HAND_COINS_REWARD;
  db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(newCoins, userId);
  return { coins: newCoins, delta: HAND_COINS_REWARD };
}

export { claimDailyReward, hasUnclaimedDailyReward, applyHandCoinsReward, DAILY_REWARD_TABLE, HAND_COINS_REWARD };
