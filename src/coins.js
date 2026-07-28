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

// Flat reward for simply being dealt into a hand while logged in - kept for
// room-mode seats other than the local human (per-seat difficulty tracking
// doesn't exist for arbitrary room players yet). Ranked play now earns no
// coins at all - see the coinsEarned block in TableGame.handleHandComplete
// - and solo unranked/experimental play uses computeHandCoinsDelta below
// instead.
const HAND_COINS_REWARD = 2;

// Unranked/experimental coin reward, keyed by bot difficulty rather than how
// big the win was - a bigger win against Easy bots doesn't pay more than a
// min-raise win against Easy bots, but the SAME win against Expert bots pays
// more, since that's a harder, more meaningful result either way. A hand you
// didn't come out ahead on (fold, lose at showdown, or break exactly even)
// costs a flat 1 coin regardless of difficulty.
const DIFFICULTY_COIN_REWARD = {
  easy: { win: 2, loss: -1 },
  medium: { win: 4, loss: -1 },
  hard: { win: 6, loss: -1 },
  expert: { win: 8, loss: -1 },
};

// The 5 "experimental" bot personalities (Drunk, Bluffer, Rock, Maniac,
// Boardroom) sit outside the Easy/Medium/Hard/Expert ladder entirely, so
// they - and any other unrecognized difficulty value - fall back to this,
// matching Easy's payout.
const EXPERIMENTAL_COIN_REWARD = { win: 1, loss: -1 };

// won: whether this player came out ahead this hand (their own payout minus
// their own contribution was positive). difficulty: the bot difficulty the
// hand was played at (TableGame.difficulty) - looked up in
// DIFFICULTY_COIN_REWARD, falling back to EXPERIMENTAL_COIN_REWARD for the
// experimental personalities and anything else unrecognized.
function computeHandCoinsDelta({ difficulty, won }) {
  const entry = DIFFICULTY_COIN_REWARD[difficulty] || EXPERIMENTAL_COIN_REWARD;
  return { delta: won ? entry.win : entry.loss, tier: difficulty };
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
  DAILY_REWARD_TABLE, HAND_COINS_REWARD, DIFFICULTY_COIN_REWARD,
};
