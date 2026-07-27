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

// Flat reward for simply being dealt into a hand while logged in - kept as
// the reward for Ranked (which already has its own XP-based progression;
// coins there are a simple bonus, not tied to result) and for room-mode
// seats other than the local human (per-seat win-streak tracking doesn't
// exist for arbitrary room players yet). Unranked/experimental solo play
// uses computeHandCoinsDelta below instead - see its own comment.
const HAND_COINS_REWARD = 2;

// A win/loss streak of at least this many hands in a row starts earning a
// bonus equal to the streak length itself (3 in a row = +3 bonus, 4 in a row
// = +4, and so on) - an escalating incentive to keep a hot streak going,
// on top of (not instead of) the normal win-tier amount below.
const WIN_STREAK_BONUS_THRESHOLD = 3;

// Unranked/experimental coin reward, scaled by how big the win actually was
// relative to the starting stack, rather than a flat amount regardless of
// pot size - a min-raise nit-win and an all-in double-up shouldn't pay the
// same. A hand you didn't come out ahead on (fold, lose at showdown, or
// break exactly even) costs a flat 1 coin regardless of how much you lost -
// losing bigger doesn't cost extra, winning bigger earns more.
const WIN_TIER_THRESHOLDS = [
  { minRatio: 0.5, delta: 3, tier: "massiveWin" },
  { minRatio: 0.2, delta: 2, tier: "bigWin" },
  { minRatio: 0, delta: 1, tier: "win" },
];

// netThisHand: this player's own payout minus their own contribution for the
// hand (positive = won money, zero or negative = didn't). winStreak: the
// running win-streak count AFTER this hand (see TableGame.stats.
// currentStreak) - only its sign/magnitude matters, a loss streak (negative)
// never grants a bonus.
function computeHandCoinsDelta({ netThisHand, startingStack, winStreak = 0 }) {
  if (netThisHand <= 0) {
    return { delta: -1, tier: "loss", streakBonus: 0 };
  }
  const ratio = startingStack > 0 ? netThisHand / startingStack : 0;
  const { delta: tierDelta, tier } = WIN_TIER_THRESHOLDS.find((t) => ratio >= t.minRatio);
  const streakBonus = winStreak >= WIN_STREAK_BONUS_THRESHOLD ? winStreak : 0;
  return { delta: tierDelta + streakBonus, tier, streakBonus };
}

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

// Applies a per-hand coins delta (positive or negative - see
// computeHandCoinsDelta) and floors at 0, same flooring discipline as
// applyXpDelta (src/auth.js) - a coin balance can never go negative. Returns
// the ACTUAL delta applied (which can differ from the requested one right
// at the floor, e.g. a -1 charge against a 0 balance actually changes
// nothing), not the theoretical one, so the client shows what really
// happened rather than a delta that would have gone negative.
function applyHandCoinsReward(db, userId, delta) {
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  const newCoins = Math.max(0, row.coins + delta);
  const actualDelta = newCoins - row.coins;
  db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(newCoins, userId);
  return { coins: newCoins, delta: actualDelta };
}

export {
  claimDailyReward, hasUnclaimedDailyReward, applyHandCoinsReward,
  computeHandCoinsDelta,
  DAILY_REWARD_TABLE, HAND_COINS_REWARD, WIN_STREAK_BONUS_THRESHOLD,
};
