import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { applyRankedHandStats } from "../src/userStats.js";

function seedUser(db, displayName) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
    VALUES (?, ?, 'x', 'x', 0)
  `).run(displayName.toLowerCase() + "@example.com", displayName);
  return Number(info.lastInsertRowid);
}

test("applyRankedHandStats returns null for a user id that doesn't exist", () => {
  const db = openDb(":memory:");
  assert.equal(applyRankedHandStats(db, 99999, { won: true, contributed: 20, payout: 40, potSize: 40 }), null);
});

test("applyRankedHandStats increments hands_played every call, hands_won only on a win", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Nia");

  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 40, potSize: 40 });
  applyRankedHandStats(db, userId, { won: false, contributed: 20, payout: 0, potSize: 40 });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.equal(row.hands_played, 2);
  assert.equal(row.hands_won, 1);
});

test("total_winnings only counts hands actually won (payout > 0) - matching TableGame's own session stat definition", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Omar");

  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 60, potSize: 60 });
  applyRankedHandStats(db, userId, { won: false, contributed: 20, payout: 0, potSize: 60 });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.equal(row.total_winnings, 60, "only the won hand's payout should count");
  assert.equal(row.total_invested, 40, "both hands' contributions should count");
  assert.equal(row.net_profit, 20);
});

test("biggest_pot/biggest_win/biggest_loss track the running max/max/min across hands", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Priya");

  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 60, potSize: 60 }); // net +40
  applyRankedHandStats(db, userId, { won: false, contributed: 100, payout: 0, potSize: 200 }); // net -100
  applyRankedHandStats(db, userId, { won: true, contributed: 10, payout: 30, potSize: 30 }); // net +20 (smaller, shouldn't overwrite biggest_win)

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.equal(row.biggest_pot, 200);
  assert.equal(row.biggest_win, 40);
  assert.equal(row.biggest_loss, -100);
});

test("showdowns_seen/showdowns_won only increment when the hand actually reached showdown", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Quinn");

  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 40, potSize: 40, showdown: false }); // won without showdown (everyone folded)
  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 40, potSize: 40, showdown: true, showdownWon: true });
  applyRankedHandStats(db, userId, { won: false, contributed: 20, payout: 0, potSize: 40, showdown: true, showdownWon: false });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.equal(row.showdowns_seen, 2);
  assert.equal(row.showdowns_won, 1);
});

test("ranked_seconds_played accumulates across hands, for the profile's hours-played stat", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Reza");

  applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 40, potSize: 40, elapsedSeconds: 45 });
  applyRankedHandStats(db, userId, { won: false, contributed: 20, payout: 0, potSize: 40, elapsedSeconds: 30 });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.equal(row.ranked_seconds_played, 75);
});

test("win % and hours played can be derived correctly from the raw persisted columns", () => {
  const db = openDb(":memory:");
  const userId = seedUser(db, "Sana");

  for (let i = 0; i < 3; i++) applyRankedHandStats(db, userId, { won: true, contributed: 20, payout: 40, potSize: 40, elapsedSeconds: 1200 });
  applyRankedHandStats(db, userId, { won: false, contributed: 20, payout: 0, potSize: 40, elapsedSeconds: 1200 });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const winPct = row.hands_won / row.hands_played;
  const hoursPlayed = row.ranked_seconds_played / 3600;
  assert.equal(winPct, 0.75);
  assert.equal(hoursPlayed, 4800 / 3600);
});
