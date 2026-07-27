import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { TableGame } from "./src/tableGame.js";
import { buildHandAnalysis } from "./src/handAnalysis.js";
import { SessionRegistry } from "./src/sessionRegistry.js";
import { parseCookies, serializeCookie } from "./src/cookies.js";
import { openDb } from "./src/db.js";
import * as auth from "./src/auth.js";
import { getLeaderboard } from "./src/leaderboard.js";
import { rankForXp } from "./src/rankTiers.js";
import { RANKED_FIXED_SETTINGS, tournamentLengthForKey } from "./src/rankedConfig.js";
import { claimDailyReward, hasUnclaimedDailyReward } from "./src/coins.js";
import { getCatalogForUser, unlockCosmetic, equipCosmetic } from "./src/cosmetics.js";
import { getDashboardStats } from "./src/analytics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Required for req.secure/req.ip to reflect the real client (via
// X-Forwarded-Proto/X-Forwarded-For) once this sits behind a reverse proxy
// or load balancer in production, rather than the proxy's own local
// connection - both the Secure cookie flag below and the login rate
// limiter's IP-based key depend on this being accurate.
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);

const SESSION_COOKIE = "ppSession";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds
const AUTH_COOKIE = "ppAuth";
// Only mark cookies Secure (HTTPS-only) once actually deployed - a local
// http://localhost dev server would otherwise never receive them back from
// the browser at all, breaking login during development.
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Merely importing this module (as every test/*.test.js file does, to reuse
// TableGame/buildHandAnalysis) would otherwise create a real sqlite file on
// disk as a side effect - node --test sets NODE_TEST_CONTEXT itself, so use
// an in-memory db by default there instead, unless a real path is given
// explicitly (PAPERPOKER_DB_PATH is how the manual/browser verification runs
// point this at a disposable file instead of the real dev database).
const DB_PATH = process.env.PAPERPOKER_DB_PATH
  || (process.env.NODE_TEST_CONTEXT ? ":memory:" : path.join(__dirname, "data", "paperpoker.sqlite"));
const db = openDb(DB_PATH);

function emailLooksValid(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Every visitor gets a long-lived, httpOnly session id up front - this is
// what lets each browser get its own isolated TableGame instead of everyone
// colliding in one global game (see SessionRegistry). Set here, on the plain
// HTTP response for the page load itself, so it's already present by the
// time the page's script opens its socket.io connection.
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies[SESSION_COOKIE]) {
    const sessionId = crypto.randomUUID();
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_MAX_AGE, secure: IS_PRODUCTION }));
    req.ppSessionId = sessionId;
  } else {
    req.ppSessionId = cookies[SESSION_COOKIE];
  }
  next();
});

app.use(express.static(__dirname));
app.use(express.json());

app.post("/api/signup", async (req, res) => {
  if (auth.isSignupRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many accounts created from this network recently. Please try again later." });
  }
  const { email, password, displayName } = req.body || {};
  if (!emailLooksValid(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const trimmedName = typeof displayName === "string" ? displayName.trim() : "";
  if (!trimmedName || trimmedName.length > 24) {
    return res.status(400).json({ error: "Display name must be 1-24 characters." });
  }
  auth.recordSignupAttempt(req.ip);
  if (auth.findUserByEmail(db, email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const { hash, salt } = await auth.hashPassword(password);
  let userId;
  try {
    userId = auth.createUser(db, { email, displayName: trimmedName, passwordHash: hash, passwordSalt: salt });
  } catch (err) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const { token, expiresAt } = auth.issueSession(db, userId);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, token, { maxAge: Math.floor((expiresAt - Date.now()) / 1000), secure: IS_PRODUCTION }));
  res.json({ user: auth.toPublicUser(auth.findUserById(db, userId)), hasUnclaimedDailyReward: hasUnclaimedDailyReward(db, userId) });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!emailLooksValid(email) || typeof password !== "string") {
    return res.status(400).json({ error: "Invalid email or password." });
  }

  const rateLimitKey = `${email.toLowerCase()}:${req.ip}`;
  if (auth.isRateLimited(rateLimitKey)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }

  const row = auth.findUserByEmail(db, email);
  const valid = row ? await auth.verifyPassword(password, row.password_salt, row.password_hash) : false;
  if (!row || !valid) {
    auth.recordLoginFailure(rateLimitKey);
    // Deliberately the same generic message either way - never reveal
    // whether the email or the password was the one that didn't match.
    return res.status(401).json({ error: "Invalid email or password." });
  }
  auth.clearLoginAttempts(rateLimitKey);

  const { token, expiresAt } = auth.issueSession(db, row.id);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, token, { maxAge: Math.floor((expiresAt - Date.now()) / 1000), secure: IS_PRODUCTION }));
  res.json({ user: auth.toPublicUser(row), hasUnclaimedDailyReward: hasUnclaimedDailyReward(db, row.id) });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  auth.destroySession(db, cookies[AUTH_COOKIE]);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, "", { maxAge: 0, secure: IS_PRODUCTION }));
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  res.json({
    user: auth.toPublicUser(user),
    hasUnclaimedDailyReward: user ? hasUnclaimedDailyReward(db, user.id) : false,
  });
});

// Claims today's daily-login coin reward, if it hasn't been claimed yet
// today - server computes and validates everything (the streak, the amount,
// whether it's actually a new day), never trusts a client-sent claim.
app.post("/api/claim-daily-reward", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  const result = claimDailyReward(db, user.id);
  if (!result) return res.status(404).json({ error: "User not found." });
  res.json(result);
});

// The cosmetics catalog annotated with this user's own owned/equipped state.
// Guests get a 401 - the shop has nothing to show without an account to
// track ownership against.
app.get("/api/cosmetics", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json(getCatalogForUser(db, user.id));
});

// Spends coins to unlock a cosmetic - server validates cost, ownership, and
// balance itself; never trusts a client-sent claim of any of it.
app.post("/api/cosmetics/unlock", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  const { category, key } = req.body || {};
  if (category !== "cardBack" && category !== "feltColor") {
    return res.status(400).json({ error: "Unknown cosmetic category." });
  }
  const result = unlockCosmetic(db, user.id, category, String(key || ""));
  if (!result) return res.status(404).json({ error: "User not found." });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Equips an already-owned cosmetic.
app.post("/api/cosmetics/equip", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  const { category, key } = req.body || {};
  if (category !== "cardBack" && category !== "feltColor") {
    return res.status(400).json({ error: "Unknown cosmetic category." });
  }
  const result = equipCosmetic(db, user.id, category, String(key || ""));
  if (!result) return res.status(404).json({ error: "User not found." });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// A user's own profile - ranked-match stats only, per how it's scoped on the
// client. No lookup-by-id yet (just "view your own"), but the shape here has
// room to grow into that later without a breaking change.
app.get("/api/profile", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json({
    displayName: user.display_name,
    rank: rankForXp(user.total_xp),
    totalXp: user.total_xp,
    handsPlayed: user.hands_played,
    handsWon: user.hands_won,
    winPct: user.hands_played > 0 ? user.hands_won / user.hands_played : null,
    hoursPlayed: user.ranked_seconds_played / 3600,
    netProfit: user.net_profit,
    biggestPot: user.biggest_pot,
    biggestWin: user.biggest_win,
    biggestLoss: user.biggest_loss,
    showdownsSeen: user.showdowns_seen,
    showdownsWon: user.showdowns_won,
    wsdPct: user.showdowns_seen > 0 ? user.showdowns_won / user.showdowns_seen : null,
  });
});

// Public - no auth needed to view who's on top, only to appear on it.
app.get("/api/leaderboard", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  const period = req.query.period === "week" ? "week" : "all";
  res.json(getLeaderboard(db, user ? user.id : null, 50, period));
});

// Internal-only growth/retention dashboard - never linked from the
// player-facing app. Gated on the raw is_admin column (never exposed via
// auth.toPublicUser, which deliberately strips it), resolved the same
// never-trust-the-client way as every other session check here.
app.get("/api/admin/stats", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user || !user.is_admin) return res.status(404).json({ error: "Not found." });
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  res.json(getDashboardStats(db, days));
});

const registry = new SessionRegistry(io, db);

io.on("connection", (socket) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  let sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    // No cookie support (blocked, or a non-browser client) - fall back to an
    // ephemeral per-socket session rather than failing outright. Degrades to
    // "doesn't survive a refresh" instead of breaking.
    sessionId = socket.id;
    console.warn(`No ${SESSION_COOKIE} cookie on socket ${socket.id} - falling back to an ephemeral per-socket session (won't survive a page refresh).`);
  }

  console.log("Client connected:", socket.id, "session:", sessionId);
  socket.join(sessionId);
  const entry = registry.touch(sessionId, socket.id);
  if (!entry) {
    // Session cap hit (see SessionRegistry.MAX_SESSIONS) - refuse rather
    // than creating unbounded state. A real browser session already has
    // one (the cookie was set on the page load before this socket ever
    // opened), so this only ever turns away abusive cookie-less connection
    // spam, never a normal returning visitor.
    socket.emit("fatalError", { message: "Server is at capacity - please try again shortly." });
    socket.disconnect(true);
    return;
  }
  const tableGame = entry.tableGame;

  // Resolved once up front so later phases (ranked play, leaderboards) can
  // read socket.data.user without re-parsing cookies - null for a logged-out
  // visitor, inert until something actually branches on it.
  const authCookies = parseCookies(socket.handshake.headers.cookie);
  socket.data.user = auth.resolveSession(db, authCookies[AUTH_COOKIE]);
  // Set once createRoom/joinRoom succeeds - null means "this socket is just
  // playing its own solo session", not in a private room at all.
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.emit("gameState", tableGame.getState());
  socket.emit("tableInfo", {
    smallBlind: tableGame.smallBlind, bigBlind: tableGame.bigBlind, minRaise: tableGame.minRaise,
  });

  // Resolves which TableGame - and which seat within it - this socket's
  // events currently apply to: its own solo session by default, or a shared
  // room's TableGame once createRoom/joinRoom has succeeded.
  function activeGame() {
    if (socket.data.roomCode) {
      const room = registry.getRoom(socket.data.roomCode);
      return room ? room.tableGame : null;
    }
    return tableGame;
  }
  function activePlayerId() {
    return socket.data.roomCode ? socket.data.playerId : "You";
  }
  // Solo has no concept of a host to gate on - only room mode does.
  function isHostOrSolo() {
    return !socket.data.roomCode || registry.isRoomHost(socket.data.roomCode, sessionId);
  }

  socket.on("createRoom", (payload, ack) => {
    try {
      // userId set last so a client can never override it by sneaking its
      // own "userId" field into payload - socket.data.user was resolved
      // server-side from the auth cookie at connection time, never trusted
      // from the client directly.
      const result = registry.createRoom(sessionId, socket, { ...(payload || {}), userId: socket.data.user ? socket.data.user.id : null });
      socket.data.roomCode = result.code;
      socket.data.playerId = result.playerId;
      if (typeof ack === "function") ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === "function") ack({ ok: false, error: err.message });
    }
  });

  socket.on("joinRoom", (payload, ack) => {
    try {
      const code = ((payload && payload.code) || "").toUpperCase().trim();
      const result = registry.joinRoom(sessionId, socket, code, { ...(payload || {}), userId: socket.data.user ? socket.data.user.id : null });
      socket.data.roomCode = result.code;
      socket.data.playerId = result.playerId;
      if (typeof ack === "function") ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === "function") ack({ ok: false, error: err.message });
    }
  });

  socket.on("leaveRoom", () => {
    if (!socket.data.roomCode) return;
    registry.removeRoomSocket(socket.data.roomCode, socket.id);
    socket.leave("room:" + socket.data.roomCode);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.emit("gameState", tableGame.getState());
  });

  socket.on("playerAction", ({ action, amount }) => {
    const tg = activeGame();
    if (!tg) return;
    tg.applyPlayerAction(activePlayerId(), action, amount);
  });

  socket.on("nextHand", () => {
    const tg = activeGame();
    if (!tg) return;
    tg.startNewHand();
  });

  // Bot customization - meaningless in room mode (no bots), harmless no-op there.
  socket.on("updateBotCustomization", (customization) => {
    const tg = activeGame();
    if (!tg) return;
    tg.updateBotCustomization(customization);
  });

  // Hand analysis request: return hand data for analysis. Solo-only for now -
  // buildHandAnalysis() is hardcoded to "You" throughout, so it isn't
  // meaningful for a room's real, differently-identified players; the client
  // doesn't offer the Hand Replay entry point while in a room.
  socket.on("requestHandAnalysis", () => {
    if (socket.data.roomCode) return;
    const analysis = buildHandAnalysis(tableGame);
    if (analysis) socket.emit("handAnalysis", analysis);
  });

  socket.on("requestExport", () => {
    if (socket.data.roomCode) return;
    socket.emit("exportData", { handLog: tableGame.handLog, stats: tableGame.stats });
  });

  socket.on("startGame", () => {
    const tg = activeGame();
    if (!tg) return;
    if (socket.data.roomCode) {
      if (!isHostOrSolo()) return;
      tg.startGame();
      return;
    }
    tg.startGame();
  });

  socket.on("setResetBalance", ({ reset }) => {
    const tg = activeGame();
    if (!tg) return;
    tg.setResetBalanceEachHand(reset);
  });

  socket.on("setTurboMode", ({ turbo }) => {
    const tg = activeGame();
    if (!tg) return;
    tg.setTurboMode(turbo);
  });

  // Pause is host-only in a room - unlike solo, freezing the table affects
  // several real people at once, so it's a deliberate "whole table's on
  // hold" tool rather than something any seated player can unilaterally do.
  socket.on("pauseGame", () => {
    const tg = activeGame();
    if (!tg || !isHostOrSolo()) return;
    tg.setPaused(true);
  });

  socket.on("resumeGame", () => {
    const tg = activeGame();
    if (!tg || !isHostOrSolo()) return;
    tg.setPaused(false);
  });

  socket.on("updateSettings", (config) => {
    if (socket.data.roomCode) {
      if (!isHostOrSolo()) return;
      const room = registry.getRoom(socket.data.roomCode);
      if (room) room.tableGame.updateRoomSettings(config || {});
      return;
    }
    // Independent of ranked status - coins are earned in every solo mode,
    // not just ranked, so this always reflects whoever's actually logged in.
    tableGame.setHumanUserId(socket.data.user ? socket.data.user.id : null);
    const wantsRanked = !!(config && config.ranked) && !!socket.data.user;
    if (wantsRanked) {
      // Ranked ignores every client-sent table setting except difficulty -
      // fixed, immutable settings so every competitor plays under the same
      // conditions. Never trust the client for this, same as userId below.
      tableGame.updateSettings({ ...RANKED_FIXED_SETTINGS, difficulty: config && config.difficulty });
      const tournamentHands = tournamentLengthForKey(config && config.tournamentKey);
      tableGame.setRankedMode(true, socket.data.user.id, tournamentHands);
    } else {
      tableGame.updateSettings(config);
      tableGame.setRankedMode(false, null);
    }
  });

  socket.on("disconnect", () => {
    registry.removeSocket(sessionId, socket.id);
    if (socket.data.roomCode) registry.removeRoomSocket(socket.data.roomCode, socket.id);
  });
});

export { TableGame, buildHandAnalysis };

// A single throw anywhere that isn't already caught (a socket.io event
// handler is the likely spot - unlike Express routes, socket.io does not
// wrap each event listener in its own try/catch) would otherwise crash the
// whole process, taking down every connected player's game at once over one
// bad edge case. Logging and staying up is the right trade-off here: one
// session misbehaving shouldn't end the server for everyone else. This is a
// backstop for whatever isn't already handled locally, not a replacement
// for fixing the actual bug it surfaces.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server staying up):", reason);
});

const PORT = process.env.PORT || 3000;
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  server.listen(PORT, () => {
    console.log(`Paper Poker server running on port ${PORT}`);
  });
  server.on("error", (err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
