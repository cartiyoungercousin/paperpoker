import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { getSignupsByDay, getVisitorsByDay, getActiveUserCounts, getRetention, getTotals, getDashboardStats } from "../src/analytics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedVisit(db, visitedAt) {
  db.prepare("INSERT INTO site_visits (session_id, visited_at) VALUES (?, ?)").run(`s${Math.random()}`, visitedAt);
}

function seedUser(db, { createdAt, lastActiveAt, handsPlayed = 0, rankedSeconds = 0, coins = 0 } = {}) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, hands_played, ranked_seconds_played, coins)
    VALUES (?, ?, 'h', 's', ?, ?, ?, ?)
  `).run(`user${Math.random()}@example.com`, "Tester", createdAt, handsPlayed, rankedSeconds, coins);
  const id = Number(info.lastInsertRowid);
  if (lastActiveAt !== undefined) {
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(lastActiveAt, id);
  }
  return id;
}

test("getSignupsByDay zero-fills every day in range, even ones with no signups", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  seedUser(db, { createdAt: now });
  seedUser(db, { createdAt: now });
  seedUser(db, { createdAt: now - 2 * DAY_MS });

  const days = getSignupsByDay(db, 5);
  assert.equal(days.length, 5);
  assert.equal(days[days.length - 1].count, 2, "today should have 2 signups");
  assert.equal(days[days.length - 3].count, 1, "2 days ago should have 1 signup");
  assert.equal(days[days.length - 2].count, 0, "yesterday should be zero-filled, not missing");
});

test("getSignupsByDay ignores signups older than the requested window", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  seedUser(db, { createdAt: now - 40 * DAY_MS });

  const days = getSignupsByDay(db, 30);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  assert.equal(total, 0);
});

test("getVisitorsByDay zero-fills every day in range, even ones with no visits", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  seedVisit(db, now);
  seedVisit(db, now);
  seedVisit(db, now - 2 * DAY_MS);

  const days = getVisitorsByDay(db, 5);
  assert.equal(days.length, 5);
  assert.equal(days[days.length - 1].count, 2, "today should have 2 visits");
  assert.equal(days[days.length - 3].count, 1, "2 days ago should have 1 visit");
  assert.equal(days[days.length - 2].count, 0, "yesterday should be zero-filled, not missing");
});

test("getVisitorsByDay ignores visits older than the requested window", () => {
  const db = openDb(":memory:");
  seedVisit(db, Date.now() - 40 * DAY_MS);

  const days = getVisitorsByDay(db, 30);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  assert.equal(total, 0);
});

test("getActiveUserCounts buckets users correctly into dau/wau/mau by recency", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  seedUser(db, { createdAt: now, lastActiveAt: now }); // active today - counts in all three
  seedUser(db, { createdAt: now, lastActiveAt: now - 3 * DAY_MS }); // this week only
  seedUser(db, { createdAt: now, lastActiveAt: now - 20 * DAY_MS }); // this month only
  seedUser(db, { createdAt: now, lastActiveAt: now - 60 * DAY_MS }); // too old for any bucket
  seedUser(db, { createdAt: now }); // never active (last_active_at null) - excluded entirely

  const counts = getActiveUserCounts(db);
  assert.equal(counts.dau, 1);
  assert.equal(counts.wau, 2);
  assert.equal(counts.mau, 3);
});

test("getRetention only counts users old enough to have cleared the window, and correctly classifies retained vs not", () => {
  const db = openDb(":memory:");
  const now = Date.now();

  // Signed up 10 days ago, still active recently -> retained at both day1 and day7.
  seedUser(db, { createdAt: now - 10 * DAY_MS, lastActiveAt: now - 1 * DAY_MS });
  // Signed up 10 days ago, never came back after day 0 -> not retained at either.
  seedUser(db, { createdAt: now - 10 * DAY_MS, lastActiveAt: now - 10 * DAY_MS });
  // Signed up just a few hours ago - too new to count in either cohort yet.
  seedUser(db, { createdAt: now - 2 * 60 * 60 * 1000, lastActiveAt: now });

  const retention = getRetention(db);
  assert.equal(retention.day1Cohort, 2, "only the two 10-day-old users should be eligible for day-1");
  assert.equal(retention.day7Cohort, 2, "only the two 10-day-old users should be eligible for day-7");
  assert.equal(retention.day1, 0.5);
  assert.equal(retention.day7, 0.5);
});

test("getRetention returns null (not NaN or 0) when no users are old enough to be eligible yet", () => {
  const db = openDb(":memory:");
  seedUser(db, { createdAt: Date.now() });
  const retention = getRetention(db);
  assert.equal(retention.day1, null);
  assert.equal(retention.day7, null);
});

test("getTotals sums hands played, ranked seconds, and coins across every account", () => {
  const db = openDb(":memory:");
  seedUser(db, { createdAt: Date.now(), handsPlayed: 10, rankedSeconds: 100, coins: 50 });
  seedUser(db, { createdAt: Date.now(), handsPlayed: 5, rankedSeconds: 200, coins: 25 });

  const totals = getTotals(db);
  assert.equal(totals.totalUsers, 2);
  assert.equal(totals.totalHandsPlayed, 15);
  assert.equal(totals.totalRankedSecondsPlayed, 300);
  assert.equal(totals.totalCoinsOutstanding, 75);
});

// totalVisitors counts EVERY visitor session ever logged, regardless of
// whether they ever created an account - deliberately independent of
// totalUsers, which only counts people who went on to sign up.
test("getTotals counts every logged visitor session, whether or not they ever created an account", () => {
  const db = openDb(":memory:");
  seedUser(db, { createdAt: Date.now() }); // one account created
  seedVisit(db, Date.now());
  seedVisit(db, Date.now());
  seedVisit(db, Date.now() - 5 * DAY_MS);

  const totals = getTotals(db);
  assert.equal(totals.totalUsers, 1);
  assert.equal(totals.totalVisitors, 3, "visitor sessions are counted independently of signups");
});

test("getTotals handles a brand-new, empty database without throwing or returning null", () => {
  const db = openDb(":memory:");
  const totals = getTotals(db);
  assert.equal(totals.totalUsers, 0);
  assert.equal(totals.totalHandsPlayed, 0);
  assert.equal(totals.totalRankedSecondsPlayed, 0);
  assert.equal(totals.totalCoinsOutstanding, 0);
  assert.equal(totals.totalVisitors, 0);
});

test("getDashboardStats bundles signups, visitors, active users, retention, and totals together", () => {
  const db = openDb(":memory:");
  seedUser(db, { createdAt: Date.now(), lastActiveAt: Date.now() });
  seedVisit(db, Date.now());
  const stats = getDashboardStats(db, 7);
  assert.equal(stats.signupsByDay.length, 7);
  assert.equal(stats.visitorsByDay.length, 7);
  assert.equal(stats.visitorsByDay[stats.visitorsByDay.length - 1].count, 1);
  assert.ok(stats.activeUsers);
  assert.ok(stats.retention);
  assert.ok(stats.totals);
});
