import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { getLeaderboard } from "../src/leaderboard.js";

function seedUser(db, displayName, totalXp) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, total_xp)
    VALUES (?, ?, 'x', 'x', 0, ?)
  `).run(displayName.toLowerCase() + "@example.com", displayName, totalXp);
  return Number(info.lastInsertRowid);
}

function seedXpEvent(db, userId, delta, createdAt) {
  db.prepare("INSERT INTO xp_events (user_id, delta, created_at) VALUES (?, ?, ?)").run(userId, delta, createdAt);
}

test("getLeaderboard on an empty table returns an empty list and no 'you' entry", () => {
  const db = openDb(":memory:");
  const result = getLeaderboard(db, null);
  assert.deepEqual(result.leaderboard, []);
  assert.equal(result.you, null);
});

test("getLeaderboard orders entries by XP descending and numbers ranks 1..n", () => {
  const db = openDb(":memory:");
  seedUser(db, "Low", 100);
  seedUser(db, "High", 900);
  seedUser(db, "Mid", 500);

  const { leaderboard } = getLeaderboard(db, null);
  assert.deepEqual(leaderboard.map((e) => e.displayName), ["High", "Mid", "Low"]);
  assert.deepEqual(leaderboard.map((e) => e.rank), [1, 2, 3]);
  assert.deepEqual(leaderboard.map((e) => e.totalXp), [900, 500, 100]);
});

test("getLeaderboard respects the limit parameter", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 10; i++) seedUser(db, `Player${i}`, i * 10);

  const { leaderboard } = getLeaderboard(db, null, 3);
  assert.equal(leaderboard.length, 3);
  // Highest XP (Player9=90, Player8=80, Player7=70) should be the top 3.
  assert.deepEqual(leaderboard.map((e) => e.displayName), ["Player9", "Player8", "Player7"]);
});

test("getLeaderboard ties on XP are broken deterministically by id (insertion order)", () => {
  const db = openDb(":memory:");
  seedUser(db, "First", 500);
  seedUser(db, "Second", 500);

  const { leaderboard } = getLeaderboard(db, null);
  assert.deepEqual(leaderboard.map((e) => e.displayName), ["First", "Second"]);
});

test("getLeaderboard: a user inside the top N gets their 'you' entry from the same list (same rank)", () => {
  const db = openDb(":memory:");
  const highId = seedUser(db, "High", 900);
  seedUser(db, "Mid", 500);

  const { you, leaderboard } = getLeaderboard(db, highId);
  assert.ok(you);
  assert.equal(you.rank, 1);
  assert.equal(you.id, highId);
  assert.equal(leaderboard[0].id, highId);
});

test("getLeaderboard: a user outside the top N still gets an accurate rank via COUNT, without appearing in the list", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 5; i++) seedUser(db, `Player${i}`, (5 - i) * 100); // Player0=500 ... Player4=100
  const outsiderId = seedUser(db, "Outsider", 1); // lowest XP of everyone

  const { you, leaderboard } = getLeaderboard(db, outsiderId, 3);
  assert.equal(leaderboard.length, 3);
  assert.ok(!leaderboard.some((e) => e.id === outsiderId), "outsider should not appear in the top-3 list");
  assert.ok(you);
  assert.equal(you.id, outsiderId);
  assert.equal(you.rank, 6, "6th place out of 6 total users");
});

test("getLeaderboard: an unknown or null currentUserId yields no 'you' entry", () => {
  const db = openDb(":memory:");
  seedUser(db, "Someone", 500);

  assert.equal(getLeaderboard(db, null).you, null);
  assert.equal(getLeaderboard(db, 999999).you, null);
});

test("getLeaderboard: each entry includes the computed rank tier, not just raw XP", () => {
  const db = openDb(":memory:");
  seedUser(db, "Newbie", 0);
  seedUser(db, "Veteran", 50000);

  const { leaderboard } = getLeaderboard(db, null);
  const newbie = leaderboard.find((e) => e.displayName === "Newbie");
  const veteran = leaderboard.find((e) => e.displayName === "Veteran");
  assert.equal(newbie.tier.label, "Bronze III");
  assert.equal(veteran.tier.label, "PokerProfessor");
});

test("getLeaderboard(period='week') only sums xp_events within the current week, excluding older events", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
  const aliceId = seedUser(db, "Alice", 500);
  const bobId = seedUser(db, "Bob", 200);

  // Alice's total_xp (500) is almost entirely old activity from two weeks
  // ago - only a small amount happened this week.
  seedXpEvent(db, aliceId, 480, twoWeeksAgo);
  seedXpEvent(db, aliceId, 20, now);
  // Bob's total_xp (200) all happened this week.
  seedXpEvent(db, bobId, 200, now);

  const { leaderboard } = getLeaderboard(db, null, 50, "week");
  assert.deepEqual(leaderboard.map((e) => e.displayName), ["Bob", "Alice"]);
  assert.equal(leaderboard.find((e) => e.displayName === "Bob").totalXp, 200);
  assert.equal(leaderboard.find((e) => e.displayName === "Alice").totalXp, 20);
});

test("getLeaderboard(period='week'): a user with total_xp but no activity this week doesn't appear at all", () => {
  const db = openDb(":memory:");
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const dormantId = seedUser(db, "Dormant", 1000);
  seedXpEvent(db, dormantId, 1000, twoWeeksAgo);

  const activeId = seedUser(db, "Active", 50);
  seedXpEvent(db, activeId, 50, Date.now());

  const { leaderboard } = getLeaderboard(db, null, 50, "week");
  assert.deepEqual(leaderboard.map((e) => e.displayName), ["Active"]);
});

test("getLeaderboard(period='all') behavior is unchanged - still lifetime total_xp, ignores xp_events entirely", () => {
  const db = openDb(":memory:");
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const id = seedUser(db, "Someone", 777);
  seedXpEvent(db, id, 777, twoWeeksAgo);

  const { leaderboard } = getLeaderboard(db, null, 50, "all");
  assert.equal(leaderboard[0].totalXp, 777);
});

test("getLeaderboard(period='week'): a user outside the weekly top N still gets an accurate weekly rank via COUNT", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = seedUser(db, `Player${i}`, 0);
    seedXpEvent(db, id, (5 - i) * 100, now); // Player0=500 ... Player4=100
    ids.push(id);
  }
  const outsiderId = seedUser(db, "Outsider", 0);
  seedXpEvent(db, outsiderId, 1, now);

  const { you, leaderboard } = getLeaderboard(db, outsiderId, 3, "week");
  assert.equal(leaderboard.length, 3);
  assert.ok(!leaderboard.some((e) => e.id === outsiderId));
  assert.ok(you);
  assert.equal(you.rank, 6);
});
