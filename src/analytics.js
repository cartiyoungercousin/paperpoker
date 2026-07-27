// Internal growth/retention analytics for the operator's own admin
// dashboard - not exposed to players. Deliberately computed from columns
// that already exist for other reasons (users.created_at, users.
// last_active_at, set on login/session-resolve in auth.js) rather than a
// separate event-log pipeline, so this ships without a new ingestion path.
// Query volume here is small (an admin loading a dashboard occasionally),
// so pulling full row sets into JS for aggregation is simpler and plenty
// fast at this app's scale - no need for SQL date-function gymnastics.

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// One row per day for the last `days` days (including today), oldest
// first, with a signup count - zero-filled for days with no signups at all
// rather than only returning days that actually had one, so a chart never
// has to guess at missing dates.
function getSignupsByDay(db, days = 30) {
  const since = Date.now() - days * DAY_MS;
  const rows = db.prepare("SELECT created_at FROM users WHERE created_at >= ?").all(since);

  const counts = new Map();
  for (let i = 0; i < days; i++) {
    counts.set(utcDateString(Date.now() - i * DAY_MS), 0);
  }
  for (const row of rows) {
    const key = utcDateString(row.created_at);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count }));
}

// Daily/weekly/monthly active users, from the last_active_at timestamp
// resolveSession() maintains (throttled to one write per 5 minutes per
// user, so this reflects real distinct-day activity, not request volume).
function getActiveUserCounts(db) {
  const rows = db.prepare("SELECT last_active_at FROM users WHERE last_active_at IS NOT NULL").all();
  const now = Date.now();
  let dau = 0, wau = 0, mau = 0;
  for (const { last_active_at } of rows) {
    const age = now - last_active_at;
    if (age <= DAY_MS) dau++;
    if (age <= 7 * DAY_MS) wau++;
    if (age <= 30 * DAY_MS) mau++;
  }
  return { dau, wau, mau };
}

// Simple retention proxy (not a full per-cohort curve): of users who signed
// up long enough ago to have had the chance, what fraction were ever active
// at least 1/7 days after their own signup. A user only ever counts once
// they've cleared the window, so a brand-new signup doesn't drag the
// percentage down before they've had any chance to come back.
function getRetention(db) {
  const rows = db.prepare("SELECT created_at, last_active_at FROM users").all();
  const now = Date.now();

  function retentionAt(windowMs) {
    const eligible = rows.filter((r) => now - r.created_at >= windowMs);
    if (eligible.length === 0) return null;
    const retained = eligible.filter((r) => r.last_active_at && r.last_active_at - r.created_at >= windowMs);
    return retained.length / eligible.length;
  }

  return {
    day1: retentionAt(DAY_MS),
    day7: retentionAt(7 * DAY_MS),
    day1Cohort: rows.filter((r) => now - r.created_at >= DAY_MS).length,
    day7Cohort: rows.filter((r) => now - r.created_at >= 7 * DAY_MS).length,
  };
}

// Headline totals for the dashboard's top-line summary.
function getTotals(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalUsers,
      COALESCE(SUM(hands_played), 0) AS totalHandsPlayed,
      COALESCE(SUM(ranked_seconds_played), 0) AS totalRankedSecondsPlayed,
      COALESCE(SUM(coins), 0) AS totalCoinsOutstanding
    FROM users
  `).get();
  return row;
}

function getDashboardStats(db, days = 30) {
  return {
    signupsByDay: getSignupsByDay(db, days),
    activeUsers: getActiveUserCounts(db),
    retention: getRetention(db),
    totals: getTotals(db),
  };
}

export { getSignupsByDay, getActiveUserCounts, getRetention, getTotals, getDashboardStats };
