import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry, MAX_SESSIONS, MAX_ROOMS } from "../src/sessionRegistry.js";
import { openDb } from "../src/db.js";

function seedUser(db, totalXp = 0) {
  const info = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, password_salt, created_at, total_xp)
    VALUES (?, ?, 'h', 's', ?, ?)
  `).run(`user${Math.random()}@example.com`, "Tester", Date.now(), totalXp);
  return Number(info.lastInsertRowid);
}

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

// Regression coverage for a real privacy bug: powerUpPrivateInfo used to be
// relayed to the human's socket unconditionally, on the (wrong) reasoning
// that a solo session's room only ever contains that one human's own
// socket(s). That's true, but it doesn't mean the info was ever meant for
// them - most activations are BOTS using their own power-up, and every one
// of those used to leak straight to the human (e.g. seeing Victoria's Deck
// Whisperer card, or what a bot's Sleight of Hand swapped). Only the actual
// activator's own privateInfo should ever reach the human's socket.
test("powerUpActivated always broadcasts to the session's room, regardless of who activated it", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io);
  const entry = registry.getOrCreate("session-pu-1");

  entry.tableGame.emit("powerUpActivated", { playerId: "Victoria", key: "deckWhisperer", name: "Deck Whisperer", icon: "🔮", target: null });
  const relayed = io.emitted.find((e) => e.event === "powerUpActivated");
  assert.ok(relayed, "the public reveal should always relay, even for a bot's activation");
  assert.equal(relayed.roomId, "session-pu-1");
  assert.equal(relayed.payload.playerId, "Victoria");

  clearInterval(registry._sweepInterval);
});

test("powerUpPrivateInfo relays to the human's socket when the human is the one who activated it", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io);
  const entry = registry.getOrCreate("session-pu-2");

  entry.tableGame.emit("powerUpPrivateInfo", { playerId: "You", type: "deckWhisperer", card: { rank: 9, suit: "c" } });
  const relayed = io.emitted.find((e) => e.event === "powerUpPrivateInfo");
  assert.ok(relayed, "expected the human's own private info to be relayed");
  assert.equal(relayed.payload.playerId, "You");

  clearInterval(registry._sweepInterval);
});

test("powerUpPrivateInfo is NOT relayed when a bot is the one who activated it - the actual bug this fixes", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io);
  const entry = registry.getOrCreate("session-pu-3");

  // Victoria (a bot) using Deck Whisperer, and a different bot using
  // Sleight of Hand - both exactly the scenarios reported as leaking.
  entry.tableGame.emit("powerUpPrivateInfo", { playerId: "Victoria", type: "deckWhisperer", card: { rank: 9, suit: "c" } });
  entry.tableGame.emit("powerUpPrivateInfo", { playerId: "James", type: "sleightOfHand", oldCard: { rank: 2, suit: "h" }, newCard: { rank: 14, suit: "s" } });

  assert.equal(io.emitted.filter((e) => e.event === "powerUpPrivateInfo").length, 0, "a bot's own private info should never reach the human's socket");

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

// ===== Rank-up unlocks: coin bonus, bot/cosmetic unlocks, permanence
// (see src/rankUnlocks.js for the tier->grant table this is driven by) =====

test("crossing a rank tier for the first time grants the coin bonus and announces what was unlocked", () => {
  const io = fakeIo();
  const db = openDb(":memory:");
  const registry = new SessionRegistry(io, db);
  const entry = registry.getOrCreate("session-rankup");

  const userId = seedUser(db, 750); // just below Silver III's 800 threshold
  entry.tableGame.emit("xpEarned", { userId, delta: 100 }); // -> 850 XP, crosses into Silver III

  const xpUpdateEvent = io.emitted.find((e) => e.event === "xpUpdate");
  assert.ok(xpUpdateEvent);
  assert.ok(xpUpdateEvent.payload.unlocked, "crossing into Silver III should announce an unlock");
  assert.equal(xpUpdateEvent.payload.unlocked.coinBonus, 60);
  assert.deepEqual(xpUpdateEvent.payload.unlocked.bots, ["rock"]);
  assert.equal(xpUpdateEvent.payload.unlocked.rankLabel, "Silver III");

  const coinsUpdateEvent = io.emitted.find((e) => e.event === "coinsUpdate");
  assert.ok(coinsUpdateEvent, "the coin bonus should also broadcast through the usual coinsUpdate channel");
  assert.equal(coinsUpdateEvent.payload.delta, 60);
  assert.equal(coinsUpdateEvent.payload.tier, "rankUp");

  const row = db.prepare("SELECT coins, highest_rank_tier_index FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 60);
  assert.equal(row.highest_rank_tier_index, 3);

  clearInterval(registry._sweepInterval);
});

test("staying within the same tier grants no coin bonus and no unlock announcement", () => {
  const io = fakeIo();
  const db = openDb(":memory:");
  const registry = new SessionRegistry(io, db);
  const entry = registry.getOrCreate("session-no-rankup");

  const userId = seedUser(db, 100); // Bronze III
  entry.tableGame.emit("xpEarned", { userId, delta: 20 }); // -> 120 XP, still Bronze III

  const xpUpdateEvent = io.emitted.find((e) => e.event === "xpUpdate");
  assert.ok(xpUpdateEvent);
  assert.equal(xpUpdateEvent.payload.unlocked, null);
  assert.equal(io.emitted.some((e) => e.event === "coinsUpdate"), false, "no coin bonus should have fired");

  clearInterval(registry._sweepInterval);
});

test("a rank-up is permanent - dipping back out of a tier and climbing back into it doesn't re-pay the bonus", () => {
  const io = fakeIo();
  const db = openDb(":memory:");
  const registry = new SessionRegistry(io, db);
  const entry = registry.getOrCreate("session-permanent-rankup");

  const userId = seedUser(db, 750);
  entry.tableGame.emit("xpEarned", { userId, delta: 100 }); // crosses into Silver III, +60 coins
  entry.tableGame.emit("xpEarned", { userId, delta: -200 }); // drops back below Silver III's threshold
  io.emitted.length = 0; // only inspect what happens on the re-climb below
  entry.tableGame.emit("xpEarned", { userId, delta: 200 }); // climbs back up past Silver III again

  const xpUpdateEvent = io.emitted.find((e) => e.event === "xpUpdate");
  assert.ok(xpUpdateEvent);
  assert.equal(xpUpdateEvent.payload.unlocked, null, "already permanently unlocked - re-crossing shouldn't pay out again");
  assert.equal(io.emitted.some((e) => e.event === "coinsUpdate"), false);

  clearInterval(registry._sweepInterval);
});

test("a big XP jump that crosses several tiers at once collects every coin bonus and unlock in between", () => {
  const io = fakeIo();
  const db = openDb(":memory:");
  const registry = new SessionRegistry(io, db);
  const entry = registry.getOrCreate("session-multi-tier-jump");

  const userId = seedUser(db, 400); // Bronze I (tier index 2)
  entry.tableGame.emit("xpEarned", { userId, delta: 1900 }); // -> 2300 XP, past Silver III (idx 3) and Silver I (idx 5) into Silver II/beyond

  const xpUpdateEvent = io.emitted.find((e) => e.event === "xpUpdate");
  assert.ok(xpUpdateEvent.payload.unlocked);
  assert.equal(xpUpdateEvent.payload.unlocked.coinBonus, 60 + 100, "both Silver III's and Silver I's coin bonuses");
  assert.deepEqual(xpUpdateEvent.payload.unlocked.bots, ["rock", "drunk"]);

  const row = db.prepare("SELECT coins, highest_rank_tier_index FROM users WHERE id = ?").get(userId);
  assert.equal(row.coins, 160);

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
