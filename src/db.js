import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
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
    showdowns_won INTEGER NOT NULL DEFAULT 0,
    ranked_seconds_played INTEGER NOT NULL DEFAULT 0,
    coins INTEGER NOT NULL DEFAULT 0,
    login_streak_days INTEGER NOT NULL DEFAULT 0,
    last_daily_reward_at INTEGER,
    equipped_card_back TEXT NOT NULL DEFAULT 'classic',
    equipped_felt_color TEXT NOT NULL DEFAULT 'green',
    is_admin INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- One row per cosmetic a user has unlocked (permanent - unlocking never
  -- expires). Equipped selection lives on users.equipped_* instead, since
  -- "owned" and "currently equipped" are independent (you can own something
  -- and not have it equipped).
  CREATE TABLE IF NOT EXISTS user_unlocks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cosmetic_key TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, cosmetic_key)
  );

  -- One row per XP change, so a "this week" leaderboard can be computed as a
  -- rolling window without a separate reset job - total_xp alone can't answer
  -- "who gained the most recently."
  CREATE TABLE IF NOT EXISTS xp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

// CREATE TABLE IF NOT EXISTS only helps a table that doesn't exist yet - it's
// a no-op for a table that was already created by an older version of this
// schema, even if that version is missing columns added since. Without this,
// every existing database created before a given column was introduced would
// throw "no such column" the first time anything tried to write to it -
// exactly what happened with ranked_seconds_played (added after players had
// already been running real databases against the schema before it).
// ADD COLUMN is the standard, safe way to backfill that gap in sqlite: each
// entry here is idempotent (skipped once the column already exists) and
// existing rows get the column's DEFAULT, same as a brand-new row would.
const USERS_COLUMN_MIGRATIONS = [
  { name: "ranked_seconds_played", ddl: "ALTER TABLE users ADD COLUMN ranked_seconds_played INTEGER NOT NULL DEFAULT 0" },
  { name: "coins", ddl: "ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0" },
  { name: "login_streak_days", ddl: "ALTER TABLE users ADD COLUMN login_streak_days INTEGER NOT NULL DEFAULT 0" },
  { name: "last_daily_reward_at", ddl: "ALTER TABLE users ADD COLUMN last_daily_reward_at INTEGER" },
  { name: "equipped_card_back", ddl: "ALTER TABLE users ADD COLUMN equipped_card_back TEXT NOT NULL DEFAULT 'classic'" },
  { name: "equipped_felt_color", ddl: "ALTER TABLE users ADD COLUMN equipped_felt_color TEXT NOT NULL DEFAULT 'green'" },
  { name: "is_admin", ddl: "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0" },
  { name: "last_active_at", ddl: "ALTER TABLE users ADD COLUMN last_active_at INTEGER" },
];

function migrateUsersTable(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  for (const { name, ddl } of USERS_COLUMN_MIGRATIONS) {
    if (!existing.has(name)) db.exec(ddl);
  }
}

// Opens (creating if necessary) the sqlite database at dbPath and ensures the
// schema exists. Pass ":memory:" for an isolated, disposable database (used
// by tests) instead of a real file on disk.
function openDb(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrateUsersTable(db);
  return db;
}

export { openDb };
