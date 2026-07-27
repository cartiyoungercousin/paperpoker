import { rankForXp } from "./rankTiers.js";

function rowToEntry(row, rank) {
  return {
    rank,
    id: row.id,
    displayName: row.display_name,
    totalXp: row.total_xp,
    tier: rankForXp(row.total_xp),
  };
}

// Most recent Monday 00:00 UTC - simple and deterministic, no timezone
// configuration needed. A user with zero XP events since then simply doesn't
// appear on the weekly board at all (matches "who's active this week", not
// "everyone, defaulting to zero").
function startOfCurrentWeekUTC(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday, 0, 0, 0, 0);
}

// Top `limit` users by XP, plus (if currentUserId is given and resolves to a
// real account) that user's own entry - taken straight from the leaderboard
// array if they're already in the top N, otherwise computed separately via a
// COUNT so a user outside the top 50 still gets an accurate rank number
// without pulling the entire users table. `id ASC` breaks XP ties
// deterministically (otherwise SQLite's tie order is unspecified, which would
// make both the leaderboard and its own tests flaky).
//
// period: 'all' (default) sorts by lifetime total_xp; 'week' sums xp_events
// since the most recent Monday 00:00 UTC instead - a rolling window, not a
// column that needs resetting on a schedule.
function getLeaderboard(db, currentUserId, limit = 50, period = "all") {
  if (period === "week") return getWeeklyLeaderboard(db, currentUserId, limit);

  const topRows = db.prepare("SELECT id, display_name, total_xp FROM users ORDER BY total_xp DESC, id ASC LIMIT ?").all(limit);
  const leaderboard = topRows.map((row, idx) => rowToEntry(row, idx + 1));

  let you = null;
  if (currentUserId != null) {
    const inTop = leaderboard.find((e) => e.id === currentUserId);
    if (inTop) {
      you = inTop;
    } else {
      const userRow = db.prepare("SELECT id, display_name, total_xp FROM users WHERE id = ?").get(currentUserId);
      if (userRow) {
        const higher = db.prepare("SELECT COUNT(*) as c FROM users WHERE total_xp > ?").get(userRow.total_xp).c;
        you = rowToEntry(userRow, higher + 1);
      }
    }
  }

  return { leaderboard, you };
}

function getWeeklyLeaderboard(db, currentUserId, limit) {
  const weekStart = startOfCurrentWeekUTC();

  const topRows = db.prepare(`
    SELECT u.id as id, u.display_name as display_name, SUM(e.delta) as total_xp
    FROM users u JOIN xp_events e ON e.user_id = u.id
    WHERE e.created_at >= ?
    GROUP BY u.id
    ORDER BY total_xp DESC, u.id ASC
    LIMIT ?
  `).all(weekStart, limit);
  const leaderboard = topRows.map((row, idx) => rowToEntry(row, idx + 1));

  let you = null;
  if (currentUserId != null) {
    const inTop = leaderboard.find((e) => e.id === currentUserId);
    if (inTop) {
      you = inTop;
    } else {
      const userRow = db.prepare(`
        SELECT u.id as id, u.display_name as display_name, SUM(e.delta) as total_xp
        FROM users u JOIN xp_events e ON e.user_id = u.id
        WHERE u.id = ? AND e.created_at >= ?
        GROUP BY u.id
      `).get(currentUserId, weekStart);
      if (userRow) {
        const higher = db.prepare(`
          SELECT COUNT(*) as c FROM (
            SELECT user_id, SUM(delta) as xp FROM xp_events WHERE created_at >= ? GROUP BY user_id HAVING xp > ?
          )
        `).get(weekStart, userRow.total_xp).c;
        you = rowToEntry(userRow, higher + 1);
      }
    }
  }

  return { leaderboard, you };
}

export { getLeaderboard };
