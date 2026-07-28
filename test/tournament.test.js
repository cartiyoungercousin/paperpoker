import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { openDb } from "../src/db.js";

// Same minimal fake of the socket.io Server API used throughout
// test/sessionRegistry.test.js - only the io.to(roomId).emit(event, payload)
// shape SessionRegistry actually calls.
function fakeIo() {
  const emitted = [];
  return {
    emitted,
    to(roomId) {
      return {
        emit(event, payload) {
          emitted.push({ roomId, event, payload });
        },
      };
    },
  };
}

function seedUser(db, coins = 0) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, coins)
    VALUES (?, ?, 'h', 's', ?, ?)
  `).run(`user${Math.random()}@example.com`, "Tester", Date.now(), coins);
  return Number(info.lastInsertRowid);
}

// completed = true seeds an already-finished, WON run (for building up a
// tier win-count history ahead of a test's real event) - active (in-
// progress) runs are the default, matching what /api/tournament/enter
// actually inserts.
function seedRun(db, userId, tierKey, { roundsCompleted = 0, entryFee = 10, completed = false } = {}) {
  const info = db.prepare(`
    INSERT INTO tournament_runs (user_id, tier_key, started_at, rounds_completed, entry_fee_paid, ended_at, won)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, tierKey, Date.now(), roundsCompleted, entryFee, completed ? Date.now() : null, completed ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function makeRegistry() {
  const db = openDb(":memory:");
  const io = fakeIo();
  const registry = new SessionRegistry(io, db);
  return { db, io, registry };
}

test("a round win that isn't the final round advances rounds_completed without ending the run", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 0);
  const runId = seedRun(db, userId, "local", { roundsCompleted: 1, entryFee: 10 });
  const entry = registry.getOrCreate("s1");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 2, won: true, tied: false,
    standings: [{ id: "You", displayName: "You", stack: 900 }],
  });

  const row = db.prepare("SELECT * FROM tournament_runs WHERE id = ?").get(runId);
  assert.equal(row.rounds_completed, 2);
  assert.equal(row.ended_at, null, "the run should still be active mid-tournament");
  assert.equal(row.won, 0);

  const relayed = io.emitted.find((e) => e.event === "tournamentRoundComplete");
  assert.ok(relayed);
  assert.equal(relayed.payload.fullyWon, false);
  assert.equal(relayed.payload.payout, 0);

  clearInterval(registry._sweepInterval);
});

test("a round loss ends the run with won:0 and no payout, regardless of which round it happened on", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 100);
  const runId = seedRun(db, userId, "local", { roundsCompleted: 2, entryFee: 10 });
  const entry = registry.getOrCreate("s2");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 3, won: false, tied: false,
    standings: [{ id: "You", displayName: "You", stack: 100 }],
  });

  const row = db.prepare("SELECT * FROM tournament_runs WHERE id = ?").get(runId);
  assert.equal(row.rounds_completed, 2, "rounds_completed only advances on a WIN, a loss just closes the run");
  assert.ok(row.ended_at, "the run should be closed out");
  assert.equal(row.won, 0);
  assert.equal(row.payout_awarded, 0);

  const coinsUser = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(coinsUser.coins, 100, "a loss awards nothing - the coin balance is untouched");

  clearInterval(registry._sweepInterval);
});

test("winning the final round (5) closes the run as won, awards the tier payout, and broadcasts coinsUpdate", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 50);
  const runId = seedRun(db, userId, "local", { roundsCompleted: 4, entryFee: 10 }); // local tier payout is 50
  const entry = registry.getOrCreate("s3");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 5, won: true, tied: false,
    standings: [{ id: "You", displayName: "You", stack: 5000 }],
  });

  const row = db.prepare("SELECT * FROM tournament_runs WHERE id = ?").get(runId);
  assert.equal(row.rounds_completed, 5);
  assert.ok(row.ended_at);
  assert.equal(row.won, 1);
  assert.equal(row.payout_awarded, 50);

  const coinsUser = db.prepare("SELECT coins FROM users WHERE id = ?").get(userId);
  assert.equal(coinsUser.coins, 100, "50 starting + 50 payout");

  const coinsEvent = io.emitted.find((e) => e.event === "coinsUpdate");
  assert.ok(coinsEvent);
  assert.equal(coinsEvent.payload.userId, userId);
  assert.equal(coinsEvent.payload.delta, 50);
  assert.equal(coinsEvent.payload.tier, "tournamentWin");

  const roundEvent = io.emitted.find((e) => e.event === "tournamentRoundComplete");
  assert.equal(roundEvent.payload.fullyWon, true);
  assert.equal(roundEvent.payload.payout, 50);
  assert.equal(roundEvent.payload.tierName, "Local PaperPoker Competition");

  clearInterval(registry._sweepInterval);
});

test("a first-ever tier win grants the first-clear cosmetic and reports it in newlyUnlocked", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 0);
  const runId = seedRun(db, userId, "local", { roundsCompleted: 4 });
  const entry = registry.getOrCreate("s4");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 5, won: true, tied: false, standings: [],
  });

  const roundEvent = io.emitted.find((e) => e.event === "tournamentRoundComplete");
  assert.deepEqual(roundEvent.payload.newlyUnlocked, [{ category: "tableTheme", key: "localTrophy" }]);

  const unlockRow = db.prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?").get(userId, "tableTheme:localTrophy");
  assert.ok(unlockRow, "the trophy should actually be owned now");

  clearInterval(registry._sweepInterval);
});

test("a 10th tier win grants the veteran name-flair too, but does NOT re-report the already-owned first-clear trophy", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 0);
  // 9 prior wins of this tier already on the books.
  for (let i = 0; i < 9; i++) seedRun(db, userId, "local", { roundsCompleted: 5, entryFee: 10, completed: true });
  // Also seed the first-clear trophy as already owned, from win #1.
  db.prepare("INSERT INTO user_unlocks (user_id, cosmetic_key, unlocked_at) VALUES (?, ?, ?)").run(userId, "tableTheme:localTrophy", Date.now());

  const runId = seedRun(db, userId, "local", { roundsCompleted: 4 }); // the 10th run, in progress
  const entry = registry.getOrCreate("s5");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 5, won: true, tied: false, standings: [],
  });

  const roundEvent = io.emitted.find((e) => e.event === "tournamentRoundComplete");
  assert.deepEqual(roundEvent.payload.newlyUnlocked, [{ category: "nameFlair", key: "localLegend" }], "only the newly-crossed veteran reward, not the already-owned trophy");

  const veteranRow = db.prepare("SELECT 1 FROM user_unlocks WHERE user_id = ? AND cosmetic_key = ?").get(userId, "nameFlair:localLegend");
  assert.ok(veteranRow);

  clearInterval(registry._sweepInterval);
});

// ===== Optimistic-concurrency guard (multi-device / stale-event safety) =====

test("a stale tournamentRoundComplete (rounds_completed doesn't match the event's expected prior count) is ignored", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 0);
  // The run is ALREADY at rounds_completed:2 (e.g. another device already
  // applied this exact advance) - a duplicate/stale event claiming to
  // advance FROM round 1 (expecting prior=1) should be a no-op.
  const runId = seedRun(db, userId, "local", { roundsCompleted: 2, entryFee: 10 });
  const entry = registry.getOrCreate("s6");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 2, won: true, tied: false, standings: [],
  });

  const row = db.prepare("SELECT * FROM tournament_runs WHERE id = ?").get(runId);
  assert.equal(row.rounds_completed, 2, "should not have been touched");
  assert.equal(row.ended_at, null);
  assert.equal(io.emitted.filter((e) => e.event === "tournamentRoundComplete").length, 0, "a stale event should not broadcast anything");

  clearInterval(registry._sweepInterval);
});

test("a tournamentRoundComplete for an already-ended run is ignored (e.g. the run was exited mid-round)", () => {
  const { db, io, registry } = makeRegistry();
  const userId = seedUser(db, 0);
  const runId = seedRun(db, userId, "local", { roundsCompleted: 2, entryFee: 10, completed: true }); // already closed out
  const entry = registry.getOrCreate("s7");

  entry.tableGame.emit("tournamentRoundComplete", {
    runId, roundNumber: 3, won: true, tied: false, standings: [],
  });

  const row = db.prepare("SELECT * FROM tournament_runs WHERE id = ?").get(runId);
  assert.equal(row.rounds_completed, 2, "an already-closed run must never be re-opened by a late event");
  assert.equal(io.emitted.filter((e) => e.event === "tournamentRoundComplete").length, 0);

  clearInterval(registry._sweepInterval);
});

test("a database problem while persisting a tournament round never propagates back into TableGame's own emit", () => {
  const { registry } = makeRegistry();
  const entry = registry.getOrCreate("s8");
  registry.db = null; // simulates a DB that's gone/unavailable

  assert.doesNotThrow(() => {
    entry.tableGame.emit("tournamentRoundComplete", { runId: 999, roundNumber: 1, won: true, tied: false, standings: [] });
  });

  clearInterval(registry._sweepInterval);
});
