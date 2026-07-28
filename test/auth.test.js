import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { openDb } from "../src/db.js";
import {
  hashPassword, verifyPassword, hashToken,
  createUser, findUserByEmail, findUserById,
  issueSession, resolveSession, destroySession, deleteAccount,
  isRateLimited, recordLoginFailure, clearLoginAttempts,
  toPublicUser, applyXpDelta,
} from "../src/auth.js";

function freshDb() {
  return openDb(":memory:");
}

test("hashPassword/verifyPassword round-trips correctly and rejects a wrong password", async () => {
  const { hash, salt } = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", salt, hash), true);
  assert.equal(await verifyPassword("wrong password", salt, hash), false);
});

test("verifyPassword rejects a foreign/corrupted hash of a different length without throwing", async () => {
  const { salt } = await hashPassword("some password");
  const shortHash = crypto.randomBytes(8).toString("hex"); // deliberately not KEY_LEN bytes
  assert.equal(await verifyPassword("some password", salt, shortHash), false);
});

test("createUser + findUserByEmail round-trip, case-insensitively", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("hunter22222");
  const id = createUser(db, { email: "Alice@Example.com", displayName: "Alice", passwordHash: hash, passwordSalt: salt });
  assert.ok(id > 0);

  const byExactCase = findUserByEmail(db, "Alice@Example.com");
  const byLowerCase = findUserByEmail(db, "alice@example.com");
  assert.ok(byExactCase);
  assert.ok(byLowerCase);
  assert.equal(byExactCase.id, byLowerCase.id);
  assert.equal(findUserById(db, id).display_name, "Alice");
});

test("duplicate email (any casing) is rejected by the UNIQUE constraint", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  createUser(db, { email: "bob@example.com", displayName: "Bob", passwordHash: hash, passwordSalt: salt });
  assert.throws(() => {
    createUser(db, { email: "BOB@EXAMPLE.COM", displayName: "Bob2", passwordHash: hash, passwordSalt: salt });
  });
});

test("issueSession stores only the token's hash, never the raw token, in the sessions table", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "carol@example.com", displayName: "Carol", passwordHash: hash, passwordSalt: salt });

  const { token } = issueSession(db, userId);
  const row = db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(userId);
  assert.ok(row);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, hashToken(token));
});

test("resolveSession returns the owning user for a valid token, and null for a bogus one", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "dave@example.com", displayName: "Dave", passwordHash: hash, passwordSalt: salt });
  const { token } = issueSession(db, userId);

  const resolved = resolveSession(db, token);
  assert.ok(resolved);
  assert.equal(resolved.id, userId);
  assert.equal(resolveSession(db, "not-a-real-token"), null);
  assert.equal(resolveSession(db, null), null);
});

test("resolveSession rejects and deletes an expired session", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "erin@example.com", displayName: "Erin", passwordHash: hash, passwordSalt: salt });
  const { token } = issueSession(db, userId);

  // Backdate the session's expiry directly, simulating time having passed.
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1000, hashToken(token));

  assert.equal(resolveSession(db, token), null);
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token));
  assert.equal(row, undefined, "expired session row should be deleted on resolution");
});

test("destroySession removes the session so it can no longer be resolved", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "frank@example.com", displayName: "Frank", passwordHash: hash, passwordSalt: salt });
  const { token } = issueSession(db, userId);

  assert.ok(resolveSession(db, token));
  destroySession(db, token);
  assert.equal(resolveSession(db, token), null);
});

test("issueSession produces unguessable, non-sequential tokens", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "grace@example.com", displayName: "Grace", passwordHash: hash, passwordSalt: salt });
  const a = issueSession(db, userId).token;
  const b = issueSession(db, userId).token;
  assert.notEqual(a, b);
  assert.equal(a.length, 64); // 32 random bytes, hex-encoded
});

test("toPublicUser exposes only safe fields (never password hash/salt) plus the computed rank", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "henry@example.com", displayName: "Henry", passwordHash: hash, passwordSalt: salt });
  const pub = toPublicUser(findUserById(db, userId));
  assert.deepEqual(
    Object.keys(pub).sort(),
    [
      "coins", "displayName", "email",
      "equippedCardBack", "equippedFeltColor", "equippedNameFlair",
      "equippedRippleColor", "equippedTableTheme", "equippedVictoryEffect",
      "id", "rank", "totalXp",
    ]
  );
  assert.equal(pub.rank.label, "Bronze III"); // brand-new account, 0 XP
  assert.equal(pub.coins, 0); // brand-new account, no coins earned yet
  assert.equal(pub.equippedCardBack, "classic");
  assert.equal(pub.equippedFeltColor, "green");
  assert.equal(pub.equippedRippleColor, "white");
  assert.equal(pub.equippedNameFlair, "none");
  assert.equal(pub.equippedTableTheme, "plain");
  assert.equal(pub.equippedVictoryEffect, "none");
  assert.equal(toPublicUser(null), null);
});

test("applyXpDelta adds/subtracts XP and floors at 0 rather than going negative", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "ivy@example.com", displayName: "Ivy", passwordHash: hash, passwordSalt: salt });

  const afterWin = applyXpDelta(db, userId, 14);
  assert.deepEqual(afterWin, { oldXp: 0, newXp: 14 });

  const afterLoss = applyXpDelta(db, userId, -100);
  assert.equal(afterLoss.oldXp, 14);
  assert.equal(afterLoss.newXp, 0, "should floor at 0, not go negative");

  assert.equal(findUserById(db, userId).total_xp, 0);
});

test("applyXpDelta returns null for a user id that doesn't exist", () => {
  const db = freshDb();
  assert.equal(applyXpDelta(db, 99999, 14), null);
});

test("applyXpDelta logs an xp_events row with the actual (post-floor) delta, for the weekly leaderboard", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "jack@example.com", displayName: "Jack", passwordHash: hash, passwordSalt: salt });

  applyXpDelta(db, userId, 14);
  const winEvent = db.prepare("SELECT * FROM xp_events WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
  assert.equal(winEvent.delta, 14);

  // A big loss that would go negative floors at 0 - the logged event should
  // reflect the actual drop (-14), not the requested one (-100).
  applyXpDelta(db, userId, -100);
  const lossEvent = db.prepare("SELECT * FROM xp_events WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
  assert.equal(lossEvent.delta, -14);
});

test("login rate limiter locks out after 5 failures and clearLoginAttempts resets it", () => {
  const key = "rate-limit-test@example.com:127.0.0.1";
  clearLoginAttempts(key);
  assert.equal(isRateLimited(key), false);

  for (let i = 0; i < 4; i++) recordLoginFailure(key);
  assert.equal(isRateLimited(key), false, "should not lock out before the 5th failure");

  recordLoginFailure(key);
  assert.equal(isRateLimited(key), true, "should lock out on the 5th failure");

  clearLoginAttempts(key);
  assert.equal(isRateLimited(key), false, "clearLoginAttempts should reset the lockout");
});

test("deleteAccount removes the user row and returns true", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "delete-me@example.com", displayName: "DeleteMe", passwordHash: hash, passwordSalt: salt });

  assert.equal(deleteAccount(db, userId), true);
  assert.equal(findUserById(db, userId), undefined);
});

test("deleteAccount returns false for a user id that doesn't exist, without throwing", () => {
  const db = freshDb();
  assert.equal(deleteAccount(db, 99999), false);
});

test("deleteAccount also removes the user's sessions, cosmetic unlocks, and xp events", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const userId = createUser(db, { email: "cleanup@example.com", displayName: "Cleanup", passwordHash: hash, passwordSalt: salt });

  const { token } = issueSession(db, userId);
  db.prepare("INSERT INTO user_unlocks (user_id, cosmetic_key, unlocked_at) VALUES (?, ?, ?)").run(userId, "cardBack:diamond", Date.now());
  applyXpDelta(db, userId, 14);

  assert.ok(db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(userId));
  assert.ok(db.prepare("SELECT * FROM user_unlocks WHERE user_id = ?").get(userId));
  assert.ok(db.prepare("SELECT * FROM xp_events WHERE user_id = ?").get(userId));

  deleteAccount(db, userId);

  assert.equal(db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(userId), undefined);
  assert.equal(db.prepare("SELECT * FROM user_unlocks WHERE user_id = ?").get(userId), undefined);
  assert.equal(db.prepare("SELECT * FROM xp_events WHERE user_id = ?").get(userId), undefined);
  // The session token itself should no longer resolve to anyone, not just
  // be silently orphaned in the sessions table.
  assert.equal(resolveSession(db, token), null);
});

test("deleteAccount only removes the targeted user, leaving other accounts untouched", async () => {
  const db = freshDb();
  const { hash, salt } = await hashPassword("password123");
  const keepId = createUser(db, { email: "keep@example.com", displayName: "Keep", passwordHash: hash, passwordSalt: salt });
  const deleteId = createUser(db, { email: "gone@example.com", displayName: "Gone", passwordHash: hash, passwordSalt: salt });

  deleteAccount(db, deleteId);

  assert.ok(findUserById(db, keepId), "the other account should be unaffected");
  assert.equal(findUserById(db, deleteId), undefined);
});
