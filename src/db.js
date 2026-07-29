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
    equipped_ripple_color TEXT NOT NULL DEFAULT 'white',
    equipped_name_flair TEXT NOT NULL DEFAULT 'none',
    equipped_table_theme TEXT NOT NULL DEFAULT 'plain',
    equipped_victory_effect TEXT NOT NULL DEFAULT 'none',
    is_admin INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER,
    highest_rank_tier_index INTEGER NOT NULL DEFAULT 0
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

  -- One row per Tournament mode attempt. Durable, unlike Ranked/Rumble's
  -- purely in-memory TableGame-session state - a tournament run spans up to
  -- 5 separate 10-hand rounds, potentially played across many separate
  -- sittings, with real coins non-refundably staked, so which round the
  -- player is on has to survive a disconnect/restart, not just live on the
  -- TableGame instance. ended_at IS NULL means the run is still active (in
  -- progress or between rounds); once set, rounds_completed/won are final.
  -- COUNT(*) WHERE won=1 for a given (user_id, tier_key) is already a
  -- correct, monotonically-non-decreasing lifetime win count for reward
  -- thresholds - no separate high-water-mark column needed the way
  -- highest_rank_tier_index is for rank tiers (this table is insert-only and
  -- won is never un-set once true, unlike total_xp which can dip).
  CREATE TABLE IF NOT EXISTS tournament_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier_key TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    rounds_completed INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    entry_fee_paid INTEGER NOT NULL,
    payout_awarded INTEGER NOT NULL DEFAULT 0
  );

  -- Enforces "one active run per user" at the DB level, not just app logic -
  -- a concurrent double-entry attempt (double-click, two tabs) throws on
  -- insert rather than silently creating two simultaneous runs.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_active_run
    ON tournament_runs(user_id) WHERE ended_at IS NULL;

  -- One row per NEW anonymous session cookie issued (see server.js's
  -- SESSION_COOKIE middleware), not one row per request/pageview - that
  -- middleware runs on literally every request (every asset, API call,
  -- socket.io poll), so logging there directly would wildly overcount. A
  -- new session cookie is only minted the first time a browser shows up
  -- without one (a genuinely new visitor, or an old one whose 30-day cookie
  -- expired/was cleared), which is exactly the "how many people have
  -- visited" signal the admin dashboard wants - logged in or not.
  CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    visited_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_site_visits_visited_at ON site_visits(visited_at);
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
  { name: "equipped_ripple_color", ddl: "ALTER TABLE users ADD COLUMN equipped_ripple_color TEXT NOT NULL DEFAULT 'white'" },
  { name: "equipped_name_flair", ddl: "ALTER TABLE users ADD COLUMN equipped_name_flair TEXT NOT NULL DEFAULT 'none'" },
  { name: "equipped_table_theme", ddl: "ALTER TABLE users ADD COLUMN equipped_table_theme TEXT NOT NULL DEFAULT 'plain'" },
  { name: "equipped_victory_effect", ddl: "ALTER TABLE users ADD COLUMN equipped_victory_effect TEXT NOT NULL DEFAULT 'none'" },
  // Highest RANK_TIERS index ever reached (see src/rankUnlocks.js) - a
  // permanent high-water mark, distinct from total_xp (which can dip after
  // a rough ranked session). Rank-gated cosmetic/bot unlocks and the
  // one-time coin bonus per rank-up all key off this, not off live XP, so
  // nothing already earned can be re-locked by a later loss streak.
  { name: "highest_rank_tier_index", ddl: "ALTER TABLE users ADD COLUMN highest_rank_tier_index INTEGER NOT NULL DEFAULT 0" },
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
