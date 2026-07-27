import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { openDb } from "../src/db.js";

// Builds a real sqlite file on disk with the OLD users table shape (missing
// ranked_seconds_played, which was added after real player databases already
// existed against the schema) - reproducing exactly the database state that
// caused "no such column: ranked_seconds_played" for anyone whose database
// predates that column, rather than just asserting against today's schema.
function makeLegacyDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-db-migration-test-"));
  const dbPath = path.join(dir, "legacy.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0,
      hands_played INTEGER NOT NULL DEFAULT 0,
      hands_won INTEGER NOT NULL DEFAULT 0,
      total_winnings INTEGER NOT NULL DEFAULT 0,
      total_invested INTEGER NOT NULL DEFAULT 0,
      net_profit INTEGER NOT NULL DEFAULT 0,
      biggest_pot INTEGER NOT NULL DEFAULT 0,
      biggest_win INTEGER NOT NULL DEFAULT 0,
      biggest_loss INTEGER NOT NULL DEFAULT 0,
      showdowns_seen INTEGER NOT NULL DEFAULT 0,
      showdowns_won INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, total_xp, hands_played)
    VALUES ('legacy@example.com', 'Legacy Player', 'h', 's', ?, 250, 12)
  `).run(Date.now());
  db.close();
  return dbPath;
}

test("openDb adds ranked_seconds_played to a pre-existing users table that predates the column", () => {
  const dbPath = makeLegacyDbFile();
  const db = openDb(dbPath);

  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(columns.includes("ranked_seconds_played"), "migration should have added the missing column");

  // The pre-existing row (created before the migration ran) should have
  // gotten the column's DEFAULT, not NULL or an error reading it back.
  const row = db.prepare("SELECT * FROM users WHERE email = 'legacy@example.com'").get();
  assert.equal(row.ranked_seconds_played, 0);
  // Untouched columns/data from before the migration should survive intact.
  assert.equal(row.display_name, "Legacy Player");
  assert.equal(row.total_xp, 250);
  assert.equal(row.hands_played, 12);

  // The exact write that used to throw "no such column: ranked_seconds_played"
  // for a legacy database should now succeed cleanly.
  assert.doesNotThrow(() => {
    db.prepare("UPDATE users SET ranked_seconds_played = ranked_seconds_played + ? WHERE id = ?").run(90, row.id);
  });
  const updated = db.prepare("SELECT ranked_seconds_played FROM users WHERE id = ?").get(row.id);
  assert.equal(updated.ranked_seconds_played, 90);

  db.close();
});

test("openDb is idempotent - running the migration again on an already-migrated database is a harmless no-op", () => {
  const dbPath = makeLegacyDbFile();
  const first = openDb(dbPath);
  first.close();

  // Re-opening (as a real server restart would) should not throw trying to
  // add a column that's already there.
  assert.doesNotThrow(() => {
    const second = openDb(dbPath);
    second.close();
  });
});

test("openDb on a brand-new database already has ranked_seconds_played from the base schema (no migration needed)", () => {
  const db = openDb(":memory:");
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(columns.includes("ranked_seconds_played"));
  db.close();
});
