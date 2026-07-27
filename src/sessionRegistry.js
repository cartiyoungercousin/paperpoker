import { TableGame } from "./tableGame.js";
import { applyXpDelta } from "./auth.js";
import { applyRankedHandStats } from "./userStats.js";
import { applyHandCoinsReward } from "./coins.js";
import { rankForXp } from "./rankTiers.js";
import { generateUniqueRoomCode } from "./roomCodes.js";

const CLEANUP_GRACE_MS = 5 * 60 * 1000; // 5 minutes - solo sessions
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const ROOM_CLEANUP_GRACE_MS = 30 * 60 * 1000; // 30 minutes - a started room, everyone disconnected
const ROOM_ABANDONED_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours - a lobby that never started a hand
const SEAT_AFK_GRACE_MS = 75 * 1000; // a room seat's own disconnect grace before auto-folding an active turn

// Hard ceilings against unbounded memory growth: a normal browser session
// always carries a real ppSession cookie (set on the very first HTTP page
// load, before the socket.io client script even runs), so it reuses the same
// session id across reconnects. A script that connects directly via a raw
// socket.io client - skipping the page load entirely - never gets that
// cookie and falls back to a fresh id (server.js's socket.id fallback) on
// every single connection, which would otherwise spin up an unbounded
// number of live TableGame instances. These caps are set far above any
// realistic legitimate concurrent-session/room count for this app; hitting
// either one always indicates abuse, not organic growth.
const MAX_SESSIONS = 5000;
const MAX_ROOMS = 1000;

// Room display names arrive as free-form client input (unlike signup's,
// which server.js already validates to 1-24 chars) - trimmed and capped to
// the same length here so one oversized name can't bloat every broadcast
// and hand-history line for the rest of the room's lifetime. The client
// already HTML-escapes any display name before rendering it, so this is
// defense-in-depth against size/abuse, not the XSS boundary itself.
function sanitizeDisplayName(name) {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 24) : "";
  return trimmed || "Player";
}

class SessionEntry {
  constructor(id, tableGame) {
    this.id = id;
    this.tableGame = tableGame;
    this.socketIds = new Set();
    this.cleanupTimer = null;
    this.emptySince = null;
  }
}

// A private room. Each seated player's id IS their ppSession cookie value
// (not a separately-generated player id) - that alone is enough to durably
// and uniquely identify "this browser" across a reconnect, so there's no
// extra seatBySession bookkeeping: "is this session already seated" is just
// tableGame.players.some(p => p.id === sessionId).
class RoomEntry {
  constructor(code, tableGame, hostSessionId) {
    this.code = code;
    this.tableGame = tableGame;
    this.hostSessionId = hostSessionId;
    this.viewerBySocket = new Map(); // socketId -> sessionId
    this.disconnectTimersBySessionId = new Map(); // per-seat AFK grace timers
    this.locked = false;
    this.createdAt = Date.now();
    this.cleanupTimer = null;
    this.emptySince = null;
  }
}

// Owns every session's (and every room's) TableGame instance, and is the only
// code that actually calls io.to(...).emit(...) - TableGame itself never
// touches io directly (see tableGame.js), it just emits lifecycle events that
// _wire()/_wireRoom() below subscribe to and re-broadcast. Solo sessions
// broadcast one shared state to a single ppSession-keyed room (everyone in it
// is the same browser, refreshed or reconnected); private rooms broadcast a
// personalized getStateFor(viewerId) to each connected socket individually,
// since real different people are seeing genuinely different things (their
// own hole cards, nobody else's).
class SessionRegistry {
  constructor(io, db) {
    this.io = io;
    this.db = db;
    this.sessions = new Map();
    this.rooms = new Map();
    this._sweepInterval = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
    this._sweepInterval.unref?.();
  }

  // Returns null (rather than throwing) when the session cap is hit and
  // sessionId isn't an existing session - callers (server.js) treat a null
  // return as "refuse this connection" instead of creating unbounded state.
  getOrCreate(sessionId) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      if (this.sessions.size >= MAX_SESSIONS) return null;
      entry = new SessionEntry(sessionId, new TableGame());
      this._wire(entry);
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  _wire(entry) {
    const io = this.io;
    const { id, tableGame } = entry;
    // Unlike the other listeners below (which just relay an already-built
    // payload), getState() does real serialization work on every call - if
    // that ever throws, an unwrapped listener here would propagate straight
    // back into TableGame's own synchronous emit() chain (checkBotTurn's
    // try/catch would misattribute it as "the bot's action failed" and
    // could leave the hand stalled), the same class of bug the XP/coins/
    // ranked-stats handlers below are already deliberately wrapped against.
    tableGame.on('stateChanged', () => {
      try {
        io.to(id).emit('gameState', tableGame.getState());
      } catch (err) {
        console.error("Failed to build/broadcast game state for session", id, ":", err);
      }
    });
    tableGame.on('botTurn', (payload) => io.to(id).emit('botTurn', payload));
    tableGame.on('botChat', (payload) => io.to(id).emit('botChat', payload));
    tableGame.on('handComplete', (payload) => io.to(id).emit('handComplete', payload));
    tableGame.on('paused', () => io.to(id).emit('pauseGame'));
    tableGame.on('resumed', () => io.to(id).emit('resumeGame'));
    tableGame.on('xpEarned', ({ userId, delta }) => this._handleXpEarned(id, userId, delta));
    tableGame.on('rankedHandComplete', (delta) => this._handleRankedHandComplete(delta));
    tableGame.on('rankedSessionComplete', (payload) => io.to(id).emit('rankedSessionComplete', payload));
    tableGame.on('coinsEarned', ({ userId }) => this._handleCoinsEarned(id, userId));
  }

  // Same shape and same reasoning as _handleXpEarned above (wrapped so a
  // database problem can never propagate back into TableGame) - persists the
  // flat per-hand coins reward and broadcasts the new balance so the nav
  // count updates live. broadcastTarget is a whole room's group in room
  // mode (potentially several different logged-in accounts listening at
  // once) - userId rides along in the payload so each client can tell
  // whether this update is actually about them.
  _handleCoinsEarned(broadcastTarget, userId) {
    if (!this.db) return;
    try {
      const result = applyHandCoinsReward(this.db, userId);
      if (!result) return;
      this.io.to(broadcastTarget).emit('coinsUpdate', { userId, delta: result.delta, coins: result.coins });
    } catch (err) {
      console.error("Failed to persist/broadcast coins for user", userId, ":", err);
    }
  }

  // Does the actual database write for a ranked hand's XP swing - TableGame
  // only ever emits the event, it has no db access itself - then broadcasts
  // the new total/rank so the client can show a "+14 XP" popup and update the
  // header badge live, without waiting for a page reload.
  //
  // Wrapped in try/catch deliberately: this runs synchronously inside
  // TableGame's own emit('xpEarned', ...) call, partway through
  // handleHandComplete(). An uncaught error here (a bad database file, a
  // schema mismatch, anything) would otherwise propagate straight back into
  // TableGame and abort the rest of hand completion - including the
  // handComplete/rankedSessionComplete events every client, ranked or not,
  // depends on to know the hand is over. A database problem should never be
  // able to take down the poker engine itself.
  _handleXpEarned(broadcastTarget, userId, delta) {
    if (!this.db) return;
    try {
      const result = applyXpDelta(this.db, userId, delta);
      if (!result) return;
      const oldRank = rankForXp(result.oldXp);
      const newRank = rankForXp(result.newXp);
      this.io.to(broadcastTarget).emit('xpUpdate', {
        delta,
        totalXp: result.newXp,
        rank: newRank,
        oldTotalXp: result.oldXp,
        oldRank,
        tierChanged: oldRank.label !== newRank.label,
      });
    } catch (err) {
      console.error("Failed to persist/broadcast XP for user", userId, ":", err);
    }
  }

  // Persists lifetime ranked stats (profile page) - a separate table/event
  // from XP, but driven by the same ranked-hand-completed moment. No
  // broadcast needed here - the profile is only read on demand via
  // GET /api/profile, not pushed live like the XP popup. See _handleXpEarned
  // above for why this is wrapped in try/catch - same reasoning applies.
  _handleRankedHandComplete(delta) {
    if (!this.db) return;
    try {
      const { userId, ...stats } = delta;
      applyRankedHandStats(this.db, userId, stats);
    } catch (err) {
      console.error("Failed to persist ranked hand stats for user", delta.userId, ":", err);
    }
  }

  // Registers a newly-connected socket against a session, cancelling any
  // pending cleanup timer. Covers the common "page refresh" case where the
  // old socket's disconnect and the new socket's connect can race in either
  // order without ever actually evicting a session that's still in use.
  // Returns null if the session cap is hit (see getOrCreate) - callers must
  // check for this rather than assuming an entry always comes back.
  touch(sessionId, socketId) {
    const entry = this.getOrCreate(sessionId);
    if (!entry) return null;
    entry.socketIds.add(socketId);
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = null;
      entry.emptySince = null;
    }
    return entry;
  }

  removeSocket(sessionId, socketId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.socketIds.delete(socketId);
    if (entry.socketIds.size === 0) this.scheduleCleanup(sessionId);
  }

  scheduleCleanup(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.cleanupTimer) return;
    entry.emptySince = Date.now();
    entry.cleanupTimer = setTimeout(() => this.dispose(sessionId), CLEANUP_GRACE_MS);
    entry.cleanupTimer.unref?.();
  }

  dispose(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.tableGame.dispose();
    this.sessions.delete(sessionId);
  }

  // ===== Private rooms =====

  // userId: callers (server.js) must always construct this options object
  // themselves as { ...clientPayload, userId: trustedValue } - the trusted
  // key coming last in that literal is what guarantees a client can never
  // override it by sneaking its own "userId" into the payload it sends.
  // It's optional (undefined for a guest, or in every existing test that
  // doesn't care about it), never trusted from anywhere else.
  createRoom(hostSessionId, socket, { displayName, settings, userId } = {}) {
    if (this.rooms.size >= MAX_ROOMS) throw new Error("Too many active rooms right now - please try again shortly.");
    const code = generateUniqueRoomCode(this.rooms);
    if (!code) throw new Error("Couldn't generate a room code - please try again.");

    const tableGame = new TableGame({ roomMode: true, ...settings });
    tableGame.addPlayer({ id: hostSessionId, displayName: sanitizeDisplayName(displayName), userId });

    const roomEntry = new RoomEntry(code, tableGame, hostSessionId);
    this._wireRoom(roomEntry);
    this.rooms.set(code, roomEntry);
    this._attachSocketToRoom(roomEntry, socket, hostSessionId);

    return { code, playerId: hostSessionId, isHost: true };
  }

  joinRoom(sessionId, socket, code, { displayName, userId } = {}) {
    const roomEntry = this.rooms.get(code);
    if (!roomEntry) throw new Error("Room not found. Double-check the code and try again.");

    const alreadySeated = roomEntry.tableGame.players.some((p) => p.id === sessionId);
    if (!alreadySeated) {
      if (roomEntry.locked) throw new Error("This room is locked and isn't accepting new players.");
      if (!roomEntry.tableGame.hasOpenSeat()) throw new Error("This room is full.");
      roomEntry.tableGame.addPlayer({ id: sessionId, displayName: sanitizeDisplayName(displayName), userId });
    }

    this._attachSocketToRoom(roomEntry, socket, sessionId);
    return { code, playerId: sessionId, isHost: sessionId === roomEntry.hostSessionId };
  }

  _wireRoom(roomEntry) {
    const io = this.io;
    const tableGame = roomEntry.tableGame;
    const broadcastGroup = "room:" + roomEntry.code;
    // Personalized per-socket state - the whole point of a private room -
    // rather than solo's single shared broadcast to one ppSession's room.
    tableGame.on('stateChanged', () => {
      try {
        for (const [socketId, sessionId] of roomEntry.viewerBySocket) {
          io.to(socketId).emit('gameState', tableGame.getStateFor(sessionId));
        }
      } catch (err) {
        console.error("Failed to build/broadcast game state for room", roomEntry.code, ":", err);
      }
    });
    // These events carry no per-viewer secret (a ripple effect, a pause
    // banner), so the shared room group is fine - no bots exist in room mode,
    // so unlike _wire() there's no 'botTurn' to relay.
    tableGame.on('handComplete', (payload) => io.to(broadcastGroup).emit('handComplete', payload));
    tableGame.on('paused', () => io.to(broadcastGroup).emit('pauseGame'));
    tableGame.on('resumed', () => io.to(broadcastGroup).emit('resumeGame'));
    tableGame.on('xpEarned', ({ userId, delta }) => this._handleXpEarned(broadcastGroup, userId, delta));
    tableGame.on('rankedHandComplete', (delta) => this._handleRankedHandComplete(delta));
    tableGame.on('rankedSessionComplete', (payload) => io.to(broadcastGroup).emit('rankedSessionComplete', payload));
    // Per-hand coins - every logged-in seat in the room gets its own event
    // (see TableGame.playerUserIds), broadcast to the whole room same as
    // solo's _handleCoinsEarned; each connected client only updates its own
    // currentUser's balance display when the userId matches them.
    tableGame.on('coinsEarned', ({ userId }) => this._handleCoinsEarned(broadcastGroup, userId));
  }

  _attachSocketToRoom(roomEntry, socket, sessionId) {
    socket.join("room:" + roomEntry.code);
    roomEntry.viewerBySocket.set(socket.id, sessionId);

    if (roomEntry.cleanupTimer) {
      clearTimeout(roomEntry.cleanupTimer);
      roomEntry.cleanupTimer = null;
      roomEntry.emptySince = null;
    }
    const pendingAfk = roomEntry.disconnectTimersBySessionId.get(sessionId);
    if (pendingAfk) {
      clearTimeout(pendingAfk);
      roomEntry.disconnectTimersBySessionId.delete(sessionId);
    }

    socket.emit('gameState', roomEntry.tableGame.getStateFor(sessionId));
  }

  isRoomHost(code, sessionId) {
    const roomEntry = this.rooms.get(code);
    return !!roomEntry && roomEntry.hostSessionId === sessionId;
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  // A seat isn't vacated on disconnect (seatBySession-equivalent identity
  // persists via sessionId) - only this one socket's viewer entry goes away.
  // If that leaves the seat's owner with zero connected sockets, start a
  // short per-seat grace timer that auto-folds them ONLY if it's actually
  // their turn when it fires, so the hand doesn't hang - they stay seated for
  // future hands regardless (no automatic bot replacement; re-seating is a
  // deliberate host action, not automatic, in an invite-only room).
  removeRoomSocket(code, socketId) {
    const roomEntry = this.rooms.get(code);
    if (!roomEntry) return;
    const sessionId = roomEntry.viewerBySocket.get(socketId);
    roomEntry.viewerBySocket.delete(socketId);
    if (!sessionId) return;

    const stillConnected = [...roomEntry.viewerBySocket.values()].includes(sessionId);
    if (!stillConnected) this._scheduleSeatAfkCheck(roomEntry, sessionId);

    if (roomEntry.viewerBySocket.size === 0) this._scheduleRoomCleanup(roomEntry.code);
  }

  _scheduleSeatAfkCheck(roomEntry, sessionId) {
    if (roomEntry.disconnectTimersBySessionId.has(sessionId)) return;
    const timer = setTimeout(() => {
      roomEntry.disconnectTimersBySessionId.delete(sessionId);
      const tableGame = roomEntry.tableGame;
      if (tableGame.hand && !tableGame.hand.complete && tableGame.hand.actingPlayerId() === sessionId) {
        tableGame.applyPlayerAction(sessionId, "fold");
      }
    }, SEAT_AFK_GRACE_MS);
    timer.unref?.();
    roomEntry.disconnectTimersBySessionId.set(sessionId, timer);
  }

  _scheduleRoomCleanup(code) {
    const roomEntry = this.rooms.get(code);
    if (!roomEntry || roomEntry.cleanupTimer) return;
    roomEntry.emptySince = Date.now();
    const grace = roomEntry.tableGame.gameStarted ? ROOM_CLEANUP_GRACE_MS : ROOM_ABANDONED_GRACE_MS;
    roomEntry.cleanupTimer = setTimeout(() => this.disposeRoom(code), grace);
    roomEntry.cleanupTimer.unref?.();
  }

  disposeRoom(code) {
    const roomEntry = this.rooms.get(code);
    if (!roomEntry) return;
    if (roomEntry.cleanupTimer) clearTimeout(roomEntry.cleanupTimer);
    for (const timer of roomEntry.disconnectTimersBySessionId.values()) clearTimeout(timer);
    roomEntry.tableGame.dispose();
    this.rooms.delete(code);
  }

  // Backstop sweep: force-disposes anything that's been empty longer than its
  // grace period but never got disposed by its own timer (e.g. the process
  // was asleep past the timer's fire time). Redundant with the per-entry
  // timers in the common case.
  sweepStale() {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (entry.socketIds.size === 0 && entry.emptySince && now - entry.emptySince > CLEANUP_GRACE_MS) {
        this.dispose(sessionId);
      }
    }
    for (const [code, roomEntry] of this.rooms) {
      if (roomEntry.viewerBySocket.size === 0 && roomEntry.emptySince) {
        const grace = roomEntry.tableGame.gameStarted ? ROOM_CLEANUP_GRACE_MS : ROOM_ABANDONED_GRACE_MS;
        if (now - roomEntry.emptySince > grace) this.disposeRoom(code);
      }
    }
  }
}

export { SessionRegistry, CLEANUP_GRACE_MS, ROOM_CLEANUP_GRACE_MS, ROOM_ABANDONED_GRACE_MS, SEAT_AFK_GRACE_MS, MAX_SESSIONS, MAX_ROOMS };
