import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry, MAX_SESSIONS, MAX_ROOMS } from "../src/sessionRegistry.js";

// A minimal fake of the subset of the socket.io Server API SessionRegistry
// actually calls (io.to(roomId).emit(event, payload)) - real socket.io isn't
// needed to verify the registry's own bookkeeping (isolation, cleanup timers,
// eviction), only that it calls the right room with the right events.
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

test("two different sessions get two completely independent TableGame instances", () => {
  const registry = new SessionRegistry(fakeIo());
  const a = registry.getOrCreate("session-a").tableGame;
  const b = registry.getOrCreate("session-b").tableGame;

  assert.notEqual(a, b);
  a.players[0].stack = 12345;
  assert.notEqual(b.players[0].stack, 12345);

  clearInterval(registry._sweepInterval);
});

test("getOrCreate is idempotent - the same session id always returns the same TableGame", () => {
  const registry = new SessionRegistry(fakeIo());
  const first = registry.getOrCreate("session-x").tableGame;
  const second = registry.getOrCreate("session-x").tableGame;
  assert.equal(first, second);

  clearInterval(registry._sweepInterval);
});

test("a session's stateChanged/botTurn/handComplete/paused/resumed events broadcast only to that session's room", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io);
  const entry = registry.getOrCreate("session-y");

  entry.tableGame.emit("stateChanged");
  entry.tableGame.emit("botTurn", { playerId: "Bot 1" });
  entry.tableGame.emit("handComplete", { youWon: true });
  entry.tableGame.emit("paused");
  entry.tableGame.emit("resumed");

  assert.ok(io.emitted.every((e) => e.roomId === "session-y"));
  assert.deepEqual(
    io.emitted.map((e) => e.event),
    ["gameState", "botTurn", "handComplete", "pauseGame", "resumeGame"]
  );

  clearInterval(registry._sweepInterval);
});

test("dispose() clears the TableGame's pending bot timer and removes the session from the registry", () => {
  const registry = new SessionRegistry(fakeIo());
  const entry = registry.getOrCreate("session-z");
  entry.tableGame.gameStarted = true;
  entry.tableGame.dealerIndex = 1; // "You" is seat 0 - this rotates first-to-act onto a bot, scheduling botTimeout
  entry.tableGame.startNewHand();

  assert.ok(entry.tableGame.botTimeout, "expected a bot timer to be pending before dispose");
  registry.dispose("session-z");

  assert.equal(entry.tableGame.botTimeout, null);
  assert.equal(registry.sessions.has("session-z"), false);

  clearInterval(registry._sweepInterval);
});

test("scheduleCleanup sets a pending timer that touch() cancels (page-refresh race: old socket disconnects, new one reconnects)", () => {
  const registry = new SessionRegistry(fakeIo());
  const entry = registry.getOrCreate("session-w");
  registry.touch("session-w", "socket-1");
  registry.removeSocket("session-w", "socket-1");

  assert.ok(entry.cleanupTimer, "expected a cleanup timer once the last socket disconnects");

  registry.touch("session-w", "socket-2");
  assert.equal(entry.cleanupTimer, null, "expected the cleanup timer to be cancelled once a new socket reconnects");
  assert.equal(registry.sessions.has("session-w"), true);

  clearInterval(registry._sweepInterval);
});

// A fake db whose prepare() always throws - reproduces exactly what a real
// schema mismatch (e.g. a database predating a column a query references)
// looks like from SessionRegistry's point of view, without needing a real
// sqlite file.
function brokenDb() {
  return { prepare() { throw new Error("no such column: ranked_seconds_played"); } };
}

test("a database error while persisting XP does not crash TableGame's own emit - xpEarned throwing never propagates back to the caller", () => {
  const registry = new SessionRegistry(fakeIo(), brokenDb());
  const entry = registry.getOrCreate("session-broken-xp");

  assert.doesNotThrow(() => {
    entry.tableGame.emit("xpEarned", { userId: 1, delta: 10 });
  }, "a broken database should be logged, not thrown back into TableGame's own event emission");

  clearInterval(registry._sweepInterval);
});

test("a database error while persisting ranked hand stats does not crash TableGame's own emit", () => {
  const registry = new SessionRegistry(fakeIo(), brokenDb());
  const entry = registry.getOrCreate("session-broken-stats");

  assert.doesNotThrow(() => {
    entry.tableGame.emit("rankedHandComplete", { userId: 1, won: true, contributed: 20, payout: 40, potSize: 40, showdown: true, showdownWon: true, elapsedSeconds: 12 });
  });

  clearInterval(registry._sweepInterval);
});

test("handComplete and rankedSessionComplete still broadcast even when the XP/stats database writes for the same hand fail", () => {
  // The real bug this reproduces: TableGame.handleHandComplete() emits
  // xpEarned and rankedHandComplete synchronously, partway through the same
  // function that later emits rankedSessionComplete and handComplete. If a
  // listener for one of the earlier events throws, EventEmitter propagates
  // that straight back into handleHandComplete() and aborts everything after
  // it - the events every client (ranked or not) needs to know the hand
  // ended never fire. This asserts the full downstream chain survives a
  // broken database, not just that the broken call itself doesn't throw.
  const io = fakeIo();
  const registry = new SessionRegistry(io, brokenDb());
  const entry = registry.getOrCreate("session-full-chain");

  entry.tableGame.emit("xpEarned", { userId: 1, delta: 10 });
  entry.tableGame.emit("rankedHandComplete", { userId: 1, won: true, contributed: 20, payout: 40, potSize: 40, showdown: true, showdownWon: true, elapsedSeconds: 12 });
  entry.tableGame.emit("rankedSessionComplete", { bustedOut: false, handsPlayed: 1 });
  entry.tableGame.emit("handComplete", { youWon: true });

  assert.deepEqual(
    io.emitted.map((e) => e.event),
    ["rankedSessionComplete", "handComplete"],
    "both events should have broadcast normally despite the earlier database failures"
  );

  clearInterval(registry._sweepInterval);
});

test("a database error while persisting coins does not crash TableGame's own emit, and handComplete still broadcasts afterward", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io, brokenDb());
  const entry = registry.getOrCreate("session-broken-coins");

  assert.doesNotThrow(() => {
    entry.tableGame.emit("coinsEarned", { userId: 1 });
  });

  entry.tableGame.emit("handComplete", { youWon: true });
  assert.deepEqual(io.emitted.map((e) => e.event), ["handComplete"]);

  clearInterval(registry._sweepInterval);
});

// Regression test for a resource-exhaustion path: a raw socket.io client
// connecting without ever sending a real ppSession cookie (server.js's
// socket.id fallback) would otherwise spin up one brand-new TableGame per
// connection with no limit. MAX_SESSIONS caps this - once hit, getOrCreate/
// touch refuse to create another session rather than growing unbounded.
test("getOrCreate/touch refuse to create a new session once MAX_SESSIONS is reached, without disturbing existing sessions", () => {
  const registry = new SessionRegistry(fakeIo());
  for (let i = 0; i < MAX_SESSIONS; i++) registry.getOrCreate(`session-${i}`);
  assert.equal(registry.sessions.size, MAX_SESSIONS);

  assert.equal(registry.getOrCreate("one-too-many"), null);
  assert.equal(registry.touch("another-new-one", "socket-x"), null);
  assert.equal(registry.sessions.size, MAX_SESSIONS, "should not have grown past the cap");

  // An already-existing session should still resolve normally - the cap
  // only blocks creating NEW ones, never breaks ones already in progress.
  assert.ok(registry.getOrCreate("session-0"));

  clearInterval(registry._sweepInterval);
});

function fakeSocket(id) {
  return { id, join() {}, emit() {} };
}

test("createRoom refuses to create a new room once MAX_ROOMS is reached", () => {
  const registry = new SessionRegistry(fakeIo());
  for (let i = 0; i < MAX_ROOMS; i++) {
    registry.createRoom(`host-${i}`, fakeSocket(`socket-${i}`), { displayName: "Host" });
  }
  assert.equal(registry.rooms.size, MAX_ROOMS);

  assert.throws(() => {
    registry.createRoom("one-too-many-host", fakeSocket("socket-extra"), { displayName: "Host" });
  }, /too many active rooms/i);
  assert.equal(registry.rooms.size, MAX_ROOMS, "should not have grown past the cap");

  clearInterval(registry._sweepInterval);
});
