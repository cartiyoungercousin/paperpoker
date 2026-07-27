import crypto from "crypto";
import { promisify } from "util";
import { rankForXp } from "./rankTiers.js";

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// scrypt is memory-hard and Node-builtin (no bcrypt dependency, no 72-byte
// password truncation footgun). Run via the promisified async form so a slow
// hash never blocks the event loop that's also driving every live game's bot
// timers.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LEN);
  return { hash: derived.toString("hex"), salt };
}

async function verifyPassword(password, salt, expectedHashHex) {
  const derived = await scrypt(password, salt, KEY_LEN);
  const expected = Buffer.from(expectedHashHex, "hex");
  // timingSafeEqual throws on mismatched lengths rather than returning false -
  // length-check first so a corrupted/foreign hash can't crash the request.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createUser(db, { email, displayName, passwordHash, passwordSalt }) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, displayName, passwordHash, passwordSalt, Date.now());
  return Number(info.lastInsertRowid);
}

function findUserByEmail(db, email) {
  return db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`).get(email);
}

function findUserById(db, id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

// Only the SHA-256 hash of a session token is ever persisted - the raw token
// lives solely in the browser's httpOnly cookie, so a stolen database dump
// can't be replayed as a login session.
function issueSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(tokenHash, userId, now, expiresAt);
  return { token, expiresAt };
}

// Only actually written at most once per this window per user, even though
// resolveSession() itself is called on every page load, every socket
// (re)connect, and every /api/me-style request - DAU/WAU only care about
// day-level granularity anyway, so there's no reason to take a write on
// every single one of those calls for an active session.
const LAST_ACTIVE_WRITE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

function resolveSession(db, token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }
  const user = findUserById(db, row.user_id);
  if (user) {
    const now = Date.now();
    if (!user.last_active_at || now - user.last_active_at >= LAST_ACTIVE_WRITE_THROTTLE_MS) {
      db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(now, user.id);
      user.last_active_at = now;
    }
  }
  return user;
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

// In-memory login rate limiter, keyed by "email:ip" - not persisted (a
// restart clears it), which is an acceptable trade-off here: this is a basic
// brute-force speed bump, not a security-critical distributed rate limit.
const loginAttempts = new Map();

function isRateLimited(key) {
  const entry = loginAttempts.get(key);
  return !!(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}

function recordLoginFailure(key) {
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || (entry.lockedUntil && entry.lockedUntil <= now)) {
    entry = { count: 0, lockedUntil: null };
  }
  entry.count++;
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.lockedUntil = now + RATE_LIMIT_WINDOW_MS;
  }
  loginAttempts.set(key, entry);
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// Separate, simpler limiter for signups - unlike login, there's no
// "failure" to count (a signup either succeeds or is rejected for being
// malformed/duplicate), so this just caps raw volume per key within a
// rolling window. Same in-memory, per-process trade-off as the login
// limiter above - a basic speed bump against account-spam, not a
// distributed rate limit.
const SIGNUP_LIMIT_MAX_ATTEMPTS = 5;
const SIGNUP_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const signupAttempts = new Map();

function isSignupRateLimited(key) {
  const entry = signupAttempts.get(key);
  if (!entry) return false;
  if (entry.windowStart + SIGNUP_LIMIT_WINDOW_MS <= Date.now()) {
    signupAttempts.delete(key);
    return false;
  }
  return entry.count >= SIGNUP_LIMIT_MAX_ATTEMPTS;
}

function recordSignupAttempt(key) {
  const now = Date.now();
  let entry = signupAttempts.get(key);
  if (!entry || entry.windowStart + SIGNUP_LIMIT_WINDOW_MS <= now) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  signupAttempts.set(key, entry);
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    totalXp: row.total_xp,
    rank: rankForXp(row.total_xp),
    coins: row.coins,
    equippedCardBack: row.equipped_card_back,
    equippedFeltColor: row.equipped_felt_color,
  };
}

// Applies a ranked-hand XP swing to a user row, floored at 0 (a rough session
// can knock XP down, and even a full rank tier, but never below zero - there's
// no tier under Bronze III to demote into). Returns null if the user no
// longer exists (e.g. deleted between the hand starting and completing).
function applyXpDelta(db, userId, delta) {
  const row = db.prepare("SELECT total_xp FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  const newXp = Math.max(0, row.total_xp + delta);
  db.prepare("UPDATE users SET total_xp = ? WHERE id = ?").run(newXp, userId);
  // Logged even when floored at 0 (the actual delta applied, not the raw
  // request) - a weekly leaderboard should reflect what really landed, not
  // what was attempted.
  const actualDelta = newXp - row.total_xp;
  db.prepare("INSERT INTO xp_events (user_id, delta, created_at) VALUES (?, ?, ?)").run(userId, actualDelta, Date.now());
  return { oldXp: row.total_xp, newXp };
}

export {
  hashPassword, verifyPassword, hashToken,
  createUser, findUserByEmail, findUserById,
  issueSession, resolveSession, destroySession,
  isRateLimited, recordLoginFailure, clearLoginAttempts,
  isSignupRateLimited, recordSignupAttempt,
  toPublicUser, applyXpDelta,
  SESSION_TTL_MS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS,
};
