import { TableGame } from "./tableGame.js";
import { applyXpDelta } from "./auth.js";
import { applyRankedHandStats } from "./userStats.js";
import { applyHandCoinsReward } from "./coins.js";
import { rankForXp, RANK_TIERS } from "./rankTiers.js";
import { tierIndexForXp, coinBonusBetweenTiers, unlocksBetweenTiers } from "./rankUnlocks.js";
import { generateUniqueRoomCode } from "./roomCodes.js";
import { grantTournamentCosmetic } from "./cosmetics.js";
import { findTournamentTier, TOURNAMENT_ROUNDS_TOTAL, TOURNAMENT_TIER_REWARDS, TOURNAMENT_VETERAN_WIN_THRESHOLD } from "./tournamentConfig.js";

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
    tableGame.on('coinsEarned', ({ userId, delta, tier }) => this._handleCoinsEarned(id, userId, delta, tier));
    // Rumble: powerUpActivated is the "everyone sees this" reveal (broadcast
    // to the whole session room, same as botChat/botTurn above) -
    // powerUpPrivateInfo is only ever meaningful to whichever player actually
    // activated the power-up. A solo session's room only ever contains the
    // one human's own socket(s), but that's NOT the same thing as "safe to
    // broadcast" - most activations are bots using their own power-up, and
    // this used to relay every one of those straight to the human's socket
    // too (the exact bug: seeing a bot's X-Ray/Deck Whisperer card, or what
    // it swapped via Sleight of Hand). Only forward it when the activator
    // actually IS the human this room belongs to.
    tableGame.on('powerUpActivated', (payload) => io.to(id).emit('powerUpActivated', payload));
    tableGame.on('powerUpPrivateInfo', (payload) => {
      const human = tableGame.players.find((p) => p.type === 'human');
      if (human && payload.playerId === human.id) io.to(id).emit('powerUpPrivateInfo', payload);
    });
    tableGame.on('rumbleSessionComplete', (payload) => io.to(id).emit('rumbleSessionComplete', payload));
    // Tournament: TableGame only ever reports a round's outcome - the actual
    // tournament_runs read/write (advance the round, close out the run,
    // award the payout, grant reward cosmetics) lives entirely here, same
    // db-writer-is-SessionRegistry's-job split as every other persisted
    // event in this file. Wrapped in try/catch like _handleXpEarned, for
    // the same reason: this runs synchronously inside TableGame's own
    // handleHandComplete(), and a DB problem must never propagate back into
    // the poker engine and abort the rest of hand completion.
    tableGame.on('tournamentRoundComplete', (payload) => this._handleTournamentRoundComplete(id, payload));
  }

  // Same shape and same reasoning as _handleXpEarned above (wrapped so a
  // database problem can never propagate back into TableGame) - persists
  // the per-hand coins delta TableGame already computed (see
  // computeHandCoinsDelta) and broadcasts the new balance so the nav count
  // (and the coin toast) updates live. broadcastTarget is a whole room's
  // group in room mode (potentially several different logged-in accounts
  // listening at once) - userId rides along in the payload so each client
  // can tell whether this update is actually about them. tier (the bot
  // difficulty this hand was played at) rides along too so the toast can
  // label which difficulty the coins came from - actualDelta (from
  // applyHandCoinsReward's floor-at-0 handling) is what's broadcast, not the
  // requested one, so the toast never claims a bigger change than what
  // really happened to the balance.
  _handleCoinsEarned(broadcastTarget, userId, delta, tier) {
    if (!this.db) return;
    try {
      const result = applyHandCoinsReward(this.db, userId, delta);
      if (!result) return;
      this.io.to(broadcastTarget).emit('coinsUpdate', { userId, delta: result.delta, coins: result.coins, tier });
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

      // Rank-up unlocks (coin bonus, experimental bots, cosmetics) key off a
      // permanent high-water-mark tier index (users.highest_rank_tier_index),
      // not this one hand's oldXp/newXp - a rough session's XP dip must
      // never re-trigger (or hide) an unlock a later win crosses back over.
      // See src/rankUnlocks.js for what each tier grants.
      const tierRow = this.db.prepare("SELECT highest_rank_tier_index FROM users WHERE id = ?").get(userId);
      const previousTierIndex = tierRow ? tierRow.highest_rank_tier_index : 0;
      const newTierIndex = tierIndexForXp(result.newXp);
      let unlocked = null;
      if (newTierIndex > previousTierIndex) {
        const coinBonus = coinBonusBetweenTiers(previousTierIndex, newTierIndex);
        const { bots, cosmetics } = unlocksBetweenTiers(previousTierIndex, newTierIndex);
        this.db.prepare("UPDATE users SET highest_rank_tier_index = ? WHERE id = ?").run(newTierIndex, userId);
        const coinResult = coinBonus > 0 ? applyHandCoinsReward(this.db, userId, coinBonus) : null;
        unlocked = { coinBonus, bots, cosmetics, rankLabel: RANK_TIERS[newTierIndex].label };
        if (coinResult) {
          this.io.to(broadcastTarget).emit('coinsUpdate', { userId, delta: coinResult.delta, coins: coinResult.coins, tier: 'rankUp' });
        }
      }

      this.io.to(broadcastTarget).emit('xpUpdate', {
        delta,
        totalXp: result.newXp,
        rank: newRank,
        oldTotalXp: result.oldXp,
        oldRank,
        tierChanged: oldRank.label !== newRank.label,
        unlocked,
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

  // Does the actual tournament_runs read/write for a round's outcome -
  // TableGame only ever reports what happened, it has no db access itself.
  // broadcastTarget is the session's room, same as every other solo-mode
  // handler here (Tournament is solo-only, no room-mode equivalent).
  _handleTournamentRoundComplete(broadcastTarget, payload) {
    if (!this.db) return;
    try {
      const { runId, roundNumber, won, tied, standings } = payload;
      if (!runId) return;

      // Optimistic-concurrency guard: the same account logged in on two
      // devices/tabs could drive two independent TableGame instances off the
      // same DB row, both finishing a round around the same time. Only apply
      // this event if the run is still active AND still sitting at exactly
      // the round count this event expects to advance from - otherwise it's
      // a stale/duplicate event (the other device already applied its own),
      // so just ignore it rather than double-advance or clobber a result.
      const run = this.db.prepare(
        "SELECT * FROM tournament_runs WHERE id = ? AND ended_at IS NULL AND rounds_completed = ?"
      ).get(runId, roundNumber - 1);
      if (!run) {
        console.warn("Ignoring stale/duplicate tournamentRoundComplete for run", runId, "round", roundNumber);
        return;
      }

      const tier = findTournamentTier(run.tier_key);
      const now = Date.now();
      const fullyWon = won && roundNumber >= TOURNAMENT_ROUNDS_TOTAL;
      let newlyUnlocked = [];

      if (!won) {
        this.db.prepare("UPDATE tournament_runs SET ended_at = ?, won = 0 WHERE id = ?").run(now, runId);
      } else if (!fullyWon) {
        this.db.prepare("UPDATE tournament_runs SET rounds_completed = ? WHERE id = ?").run(roundNumber, runId);
      } else {
        const payout = tier ? tier.payout : 0;
        this.db.prepare(
          "UPDATE tournament_runs SET rounds_completed = ?, ended_at = ?, won = 1, payout_awarded = ? WHERE id = ?"
        ).run(roundNumber, now, payout, runId);
        if (payout > 0) {
          const coinResult = applyHandCoinsReward(this.db, run.user_id, payout);
          if (coinResult) {
            this.io.to(broadcastTarget).emit('coinsUpdate', { userId: run.user_id, delta: coinResult.delta, coins: coinResult.coins, tier: 'tournamentWin' });
          }
        }

        // Reward-unlock check: a fresh COUNT of past wins for this tier is
        // already a correct, monotonically-non-decreasing lifetime win count
        // (tournament_runs is insert-only and won is never un-set once true -
        // no separate high-water-mark column needed the way rank tiers need
        // one). Granting unconditionally whenever a threshold is met, rather
        // than only on the exact crossing win, makes this self-healing
        // against any bug in an earlier deploy that might have missed one.
        const winCountRow = this.db.prepare(
          "SELECT COUNT(*) as c FROM tournament_runs WHERE user_id = ? AND tier_key = ? AND won = 1"
        ).get(run.user_id, run.tier_key);
        const winCount = winCountRow ? winCountRow.c : 0;
        const rewards = TOURNAMENT_TIER_REWARDS[run.tier_key];
        if (rewards && winCount >= 1) {
          const r = grantTournamentCosmetic(this.db, run.user_id, rewards.firstWin.category, rewards.firstWin.key);
          if (r.ok && !r.alreadyOwned) newlyUnlocked.push(rewards.firstWin);
        }
        if (rewards && winCount >= TOURNAMENT_VETERAN_WIN_THRESHOLD) {
          const r = grantTournamentCosmetic(this.db, run.user_id, rewards.veteran.category, rewards.veteran.key);
          if (r.ok && !r.alreadyOwned) newlyUnlocked.push(rewards.veteran);
        }
      }

      this.io.to(broadcastTarget).emit('tournamentRoundComplete', {
        roundNumber, won, tied, standings,
        tierKey: run.tier_key,
        tierName: tier ? tier.name : run.tier_key,
        entryFee: run.entry_fee_paid,
        fullyWon,
        payout: fullyWon ? (tier ? tier.payout : 0) : 0,
        newlyUnlocked,
      });
    } catch (err) {
      console.error("Failed to persist/broadcast tournament round completion:", err);
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
    tableGame.on('coinsEarned', ({ userId, delta, tier }) => this._handleCoinsEarned(broadcastGroup, userId, delta, tier));
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
