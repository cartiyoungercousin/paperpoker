// Deployed on Railway.
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
import { rankForXp, RANK_TIERS } from "./src/rankTiers.js";
import { RANKED_FIXED_SETTINGS, tournamentLengthForKey } from "./src/rankedConfig.js";
import { RUMBLE_FIXED_SETTINGS } from "./src/rumbleConfig.js";
import { TOURNAMENT_FIXED_SETTINGS, TOURNAMENT_TIERS, TOURNAMENT_ROUNDS, TOURNAMENT_ROUNDS_TOTAL, findTournamentTier, tournamentRoundInfo, requiredRankLabelForTier, isTournamentTierUnlockedAtRank } from "./src/tournamentConfig.js";
import { claimDailyReward, hasUnclaimedDailyReward, applyHandCoinsReward } from "./src/coins.js";
import { SPIN_COST, SPIN_SEGMENTS, pickSpinSegment } from "./src/spinConfig.js";
import { getCatalogForUser, unlockCosmetic, equipCosmetic, COSMETICS_CATALOG } from "./src/cosmetics.js";
import { isBotUnlockedAtTier, requiredTierIndexForBot } from "./src/rankUnlocks.js";
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

const EXPERIMENTAL_BOT_KEYS = new Set(["drunk", "bluffer", "rock", "maniac", "boardroom"]);

// Only the 5 experimental bot personalities are rank-gated - the core
// Easy/Medium/Hard/Expert ladder is open to everyone, always. A guest (no
// account, so no rank at all) or an account that hasn't reached the
// required tier yet gets coerced to Easy rather than rejected outright, so
// requesting a locked bot degrades gracefully into a still-playable game.
function resolveAllowedDifficulty(requestedDifficulty, user) {
  if (!EXPERIMENTAL_BOT_KEYS.has(requestedDifficulty)) return requestedDifficulty;
  if (!user) return "easy";
  const row = db.prepare("SELECT highest_rank_tier_index FROM users WHERE id = ?").get(user.id);
  const tierIndex = row ? row.highest_rank_tier_index : 0;
  return isBotUnlockedAtTier(requestedDifficulty, tierIndex) ? requestedDifficulty : "easy";
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
  const newUser = auth.findUserById(db, userId);
  res.json({
    user: auth.toPublicUser(newUser),
    hasUnclaimedDailyReward: hasUnclaimedDailyReward(db, userId),
    experimentalBots: buildExperimentalBotsPayload(newUser),
  });
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
  res.json({
    user: auth.toPublicUser(row),
    hasUnclaimedDailyReward: hasUnclaimedDailyReward(db, row.id),
    experimentalBots: buildExperimentalBotsPayload(row),
  });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  auth.destroySession(db, cookies[AUTH_COOKIE]);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, "", { maxAge: 0, secure: IS_PRODUCTION }));
  res.json({ ok: true });
});

// Permanently deletes the logged-in user's account and everything tied to
// it (coins, cosmetics, rank/XP, ranked stats). Requires re-entering the
// current password - a session cookie alone isn't enough proof of intent for
// something this irreversible (e.g. a shared/unlocked browser shouldn't be
// able to delete an account with just a click). The client is expected to
// have already shown the player exactly what they're about to lose before
// ever calling this.
app.post("/api/account/delete", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });

  const { password } = req.body || {};
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Please enter your password to confirm." });
  }
  const valid = await auth.verifyPassword(password, user.password_salt, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Incorrect password." });

  auth.deleteAccount(db, user.id);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, "", { maxAge: 0, secure: IS_PRODUCTION }));
  res.json({ ok: true });
});

// Lets the home/experimental pages show a lock overlay + the exact rank
// still needed for each experimental bot, without duplicating rank-unlock
// math client-side - the server-side gate in updateSettings is what
// actually enforces this either way. Shared by every route that returns a
// user's auth state (/api/me, /api/signup, /api/login) so all three stay
// in sync rather than the client only learning this on the next page load.
function buildExperimentalBotsPayload(user) {
  const tierIndex = user ? user.highest_rank_tier_index : 0;
  const experimentalBots = {};
  for (const botKey of EXPERIMENTAL_BOT_KEYS) {
    const unlocked = isBotUnlockedAtTier(botKey, tierIndex);
    const requiredIdx = requiredTierIndexForBot(botKey);
    experimentalBots[botKey] = { unlocked, unlockRank: unlocked || requiredIdx == null ? null : RANK_TIERS[requiredIdx].label };
  }
  return experimentalBots;
}

app.get("/api/me", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  res.json({
    user: auth.toPublicUser(user),
    hasUnclaimedDailyReward: user ? hasUnclaimedDailyReward(db, user.id) : false,
    experimentalBots: buildExperimentalBotsPayload(user),
    // Static, tiny (16 entries) - sent straight from the same RANK_TIERS
    // array everything else resolves rank labels/thresholds from, so a
    // client-side rank-ladder display can never drift out of sync with the
    // server's own tier definitions.
    rankTiers: RANK_TIERS,
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

// Derived straight from the real catalog rather than a hand-maintained list -
// a stale hardcoded whitelist here (cardBack/feltColor only) previously left
// the other 4 categories (rippleColor/nameFlair/tableTheme/victoryEffect)
// completely unreachable through these routes for months after they were
// added to the catalog, since nothing ever re-synced this check against it.
const VALID_COSMETIC_CATEGORIES = new Set(Object.keys(COSMETICS_CATALOG));

// Spends coins to unlock a cosmetic - server validates cost, ownership, and
// balance itself; never trusts a client-sent claim of any of it.
app.post("/api/cosmetics/unlock", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  const { category, key } = req.body || {};
  if (!VALID_COSMETIC_CATEGORIES.has(category)) {
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
  if (!VALID_COSMETIC_CATEGORIES.has(category)) {
    return res.status(400).json({ error: "Unknown cosmetic category." });
  }
  const result = equipCosmetic(db, user.id, category, String(key || ""));
  if (!result) return res.status(404).json({ error: "User not found." });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Ranked-match stats shape shared by "view your own profile" (/api/profile,
// auth-required) and "view anyone's public profile" (/api/users/:id/public-
// profile, no auth needed) below - deliberately leaves out anything private
// (email, coins, cosmetics ownership, login streak, admin flag): those two
// routes differ only in how they resolve the target user row, not in what
// they're willing to show.
function profileStatsPayload(user) {
  return {
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
  };
}

// A user's own profile - ranked-match stats only, per how it's scoped on the
// client.
app.get("/api/profile", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json(profileStatsPayload(user));
});

// Public profile by id - anyone (logged in or not) can view any account's
// same ranked-match stats shown on the leaderboard/their own profile - this
// is what a leaderboard row's click opens. 404s rather than exposing
// whether an id is simply out of range vs genuinely nonexistent (both look
// identical to the caller either way).
app.get("/api/users/:id/public-profile", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid user id." });
  const user = auth.findUserById(db, id);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(profileStatsPayload(user));
});

// Public - no auth needed to view who's on top, only to appear on it. limit
// is client-controlled (the home page widget asks for 5) but always clamped
// server-side to a sane max, regardless of what's requested.
app.get("/api/leaderboard", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  const period = req.query.period === "week" ? "week" : "all";
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 50;
  res.json(getLeaderboard(db, user ? user.id : null, limit, period));
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

// ===== Tournament mode (paid entry, escalating-difficulty, solo-only) =====
// Unlike Ranked/Rumble, a run's progress is durable (tournament_runs in
// src/db.js) rather than living purely on the in-memory TableGame session -
// coins are non-refundably staked across up to 5 separate 10-hand rounds,
// potentially played across many sittings, so "which round am I on" has to
// survive a disconnect or server restart. These REST routes own all the
// money/administrative writes (enter, exit); the actual live poker for a
// round still flows through the normal socket/TableGame path (see the
// beginTournamentRound handler below) and only reports a round's OUTCOME
// back through src/sessionRegistry.js's tournamentRoundComplete listener.
// Placed after `registry` (rather than up with the other REST routes above)
// since /api/tournament/exit needs it to reach into a live session.

// Shapes TOURNAMENT_TIERS for client display - attaches the human-readable
// rank requirement label and whether THIS player (permanent
// highest_rank_tier_index high-water mark, or 0 for a guest/no rank yet) has
// actually met it, so the client never has to duplicate the gating logic
// itself, only render what the server already decided. Never mutates the
// underlying config array.
function tiersForDisplay(userTierIndex) {
  return TOURNAMENT_TIERS.map((t) => ({
    ...t,
    requiredRankLabel: requiredRankLabelForTier(t.key),
    rankUnlocked: isTournamentTierUnlockedAtRank(t.key, userTierIndex),
  }));
}

// Public - tier/round definitions are just static config, safe to show a
// logged-out visitor deciding whether to sign up. coins/activeRun are only
// ever meaningful once resolveSession finds a real user. A guest sees every
// rank-gated tier as locked (rankUnlocked:false) - they'd need an account
// and a rank to enter regardless, this just keeps the shape consistent.
app.get("/api/tournament/status", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) {
    return res.json({ loggedIn: false, coins: 0, tiers: tiersForDisplay(0), rounds: TOURNAMENT_ROUNDS, activeRun: null });
  }
  const row = db.prepare("SELECT coins, highest_rank_tier_index FROM users WHERE id = ?").get(user.id);
  const runRow = db.prepare("SELECT * FROM tournament_runs WHERE user_id = ? AND ended_at IS NULL").get(user.id);
  const activeRun = runRow
    ? { id: runRow.id, tierKey: runRow.tier_key, roundsCompleted: runRow.rounds_completed, startedAt: runRow.started_at }
    : null;
  res.json({
    loggedIn: true,
    coins: row ? row.coins : 0,
    tiers: tiersForDisplay(row ? row.highest_rank_tier_index : 0),
    rounds: TOURNAMENT_ROUNDS,
    activeRun,
  });
});

// Pays the entry fee (non-refundable from this point on) and starts a new
// run. Inserts the run FIRST, only deducts coins once that succeeds - if a
// concurrent request (double-click, two tabs) already inserted an active
// run, the partial unique index (idx_tournament_active_run) makes this
// insert throw before any coins are ever touched, so there's nothing to
// refund on the conflict path.
app.post("/api/tournament/enter", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  const tier = findTournamentTier((req.body && req.body.tierKey) || "");
  if (!tier) return res.status(400).json({ error: "Unknown tournament tier." });

  const row = db.prepare("SELECT coins, highest_rank_tier_index FROM users WHERE id = ?").get(user.id);
  if (!row) return res.status(404).json({ error: "User not found." });
  // Rank gate is always re-checked here against the permanent high-water
  // mark, never trusting whatever the client's own UI happened to show -
  // same discipline as resolveAllowedDifficulty's experimental-bot gate.
  if (!isTournamentTierUnlockedAtRank(tier.key, row.highest_rank_tier_index)) {
    return res.status(400).json({ error: `Requires ${requiredRankLabelForTier(tier.key)} rank to enter.` });
  }
  if (row.coins < tier.entryFee) return res.status(400).json({ error: "Not enough coins." });

  const now = Date.now();
  let info;
  try {
    info = db.prepare(
      "INSERT INTO tournament_runs (user_id, tier_key, started_at, entry_fee_paid) VALUES (?, ?, ?, ?)"
    ).run(user.id, tier.key, now, tier.entryFee);
  } catch (err) {
    return res.status(400).json({ error: "You already have an active tournament." });
  }
  const newCoins = row.coins - tier.entryFee;
  db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(newCoins, user.id);
  res.json({
    ok: true,
    coins: newCoins,
    activeRun: { id: Number(info.lastInsertRowid), tierKey: tier.key, roundsCompleted: 0, startedAt: now },
  });
});

// Forfeits the active run - no refund of the entry fee. If a round happens
// to be in flight on this browser's live TableGame session, also cancels
// tournament mode on it so that hand just finishes as ordinary, non-
// tournament poker instead of handleHandComplete() trying to report a round
// outcome into a run that's already closed (see TableGame.cancelTournamentMode
// and SessionRegistry's tournamentRoundComplete guard, which would otherwise
// just silently ignore the stale event anyway - this is belt-and-suspenders,
// not strictly required for correctness).
app.post("/api/tournament/exit", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });

  const run = db.prepare("SELECT * FROM tournament_runs WHERE user_id = ? AND ended_at IS NULL").get(user.id);
  if (!run) return res.status(400).json({ error: "No active tournament to exit." });

  db.prepare("UPDATE tournament_runs SET ended_at = ?, won = 0 WHERE id = ?").run(Date.now(), run.id);

  const entry = registry.sessions.get(req.ppSessionId);
  if (entry && entry.tableGame.tournamentRunId === run.id) {
    entry.tableGame.cancelTournamentMode();
  }
  res.json({ ok: true });
});

// ===== Spins wheel =====
// A standalone, instant coin/XP gamble - unlike Tournament there's no
// multi-step run to track, so this is a single REST call rather than a
// socket-driven flow: charge SPIN_COST, roll a reward, apply it, respond
// with everything the client needs to animate the wheel and show the
// result. Placed after `registry` since XP application below delegates to
// SessionRegistry's own rank-up cascade (_handleXpEarned).

// Public - the segment list/cost are static config, safe to show a
// logged-out visitor. coins is only meaningful once resolveSession finds a
// real user.
app.get("/api/spins/status", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.json({ loggedIn: false, coins: 0, cost: SPIN_COST, segments: SPIN_SEGMENTS });
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(user.id);
  res.json({ loggedIn: true, coins: row ? row.coins : 0, cost: SPIN_COST, segments: SPIN_SEGMENTS });
});

// Charges the (non-refundable) spin cost BEFORE rolling the reward - same
// "pay first" discipline as Tournament entry, so a problem applying the
// reward can never result in a free spin. Coin rewards are applied directly
// here and returned in the response (same pattern as claim-daily-reward);
// XP rewards are delegated to registry._handleXpEarned so a spin that
// happens to cross a rank tier gets the exact same coin-bonus/unlock
// cascade and live xpUpdate/coinsUpdate broadcast a ranked hand would.
app.post("/api/spins/spin", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = auth.resolveSession(db, cookies[AUTH_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not logged in." });

  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(user.id);
  if (!row) return res.status(404).json({ error: "User not found." });
  if (row.coins < SPIN_COST) return res.status(400).json({ error: "Not enough coins." });

  db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(row.coins - SPIN_COST, user.id);

  const { segment, index } = pickSpinSegment();
  if (segment.type === "coins") {
    applyHandCoinsReward(db, user.id, segment.amount);
  } else if (segment.type === "xp") {
    registry._handleXpEarned(req.ppSessionId, user.id, segment.amount);
  }

  // Re-read fresh rather than computing the delta locally - a rank-up
  // triggered by the XP branch above can award its own coin bonus, which
  // this response's coins field needs to reflect.
  const finalRow = db.prepare("SELECT coins FROM users WHERE id = ?").get(user.id);
  res.json({ ok: true, index, segment, coins: finalRow ? finalRow.coins : row.coins - SPIN_COST });
});

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

  // Rumble power-up activation - v1 is solo-vs-bots only (no room-mode
  // Rumble table exists yet), same "solo-only for now" scoping already used
  // for hand analysis below. applyPowerUp() itself re-validates turn
  // ownership/availability server-side - never trusts the client's own idea
  // of whose turn it is or what they still have.
  socket.on("usePowerUp", ({ target } = {}) => {
    if (socket.data.roomCode) return;
    const tg = activeGame();
    if (!tg) return;
    tg.applyPowerUp(activePlayerId(), target);
  });

  // Starts (or resumes) the next round of the caller's active tournament run.
  // Solo-only, like Rumble - deliberately a standalone event rather than
  // reusing updateSettings, since tournament difficulty is 100% server-
  // derived from the run's own progress and never a client choice, unlike
  // Rumble's updateSettings, which still legitimately trusts a client-picked
  // difficulty. Ack-style (like createRoom/joinRoom) so the client knows
  // definitively whether the round actually started before switching its UI
  // over to the live table.
  socket.on("beginTournamentRound", (payload, ack) => {
    const respond = (result) => { if (typeof ack === "function") ack(result); };
    if (socket.data.roomCode) return respond({ ok: false, error: "Tournament mode isn't available in rooms." });
    if (!socket.data.user) return respond({ ok: false, error: "Not logged in." });

    const run = db.prepare("SELECT * FROM tournament_runs WHERE user_id = ? AND ended_at IS NULL").get(socket.data.user.id);
    if (!run) return respond({ ok: false, error: "No active tournament." });

    const nextRound = run.rounds_completed + 1;
    const info = tournamentRoundInfo(nextRound);
    if (!info) return respond({ ok: false, error: "This tournament is already complete." });

    // Idempotency: if this exact round is already underway on this table
    // (the player navigated away mid-round and came back), just report it
    // as already started rather than re-dealing - this is what makes
    // "resume mid-round" work with no separate resume UI needed.
    if (tableGame.tournamentMode && tableGame.tournamentRunId === run.id && tableGame.tournamentRoundNumber === nextRound) {
      return respond({ ok: true, roundNumber: nextRound, label: info.label, resumed: true });
    }

    tableGame.setHumanUserId(socket.data.user.id);
    tableGame.updateSettings({ ...TOURNAMENT_FIXED_SETTINGS, difficulty: info.difficulty });
    tableGame.setTournamentMode(true, { runId: run.id, roundNumber: nextRound });
    tableGame.startGame();
    respond({ ok: true, roundNumber: nextRound, label: info.label, resumed: false });
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
    // The 5 experimental bot personalities are gated behind rank milestones
    // (src/rankUnlocks.js) - never trust the client's own idea of whether
    // it's unlocked, same discipline as everything else resolved from
    // socket.data.user below. A guest or an under-ranked account requesting
    // one gets silently coerced to Easy instead.
    const safeDifficulty = resolveAllowedDifficulty(config && config.difficulty, socket.data.user);
    const wantsRanked = !!(config && config.ranked) && !!socket.data.user;
    const wantsRumble = !!(config && config.rumbleMode) && !wantsRanked;
    if (wantsRanked) {
      // Ranked ignores every client-sent table setting except difficulty -
      // fixed, immutable settings so every competitor plays under the same
      // conditions. Never trust the client for this, same as userId below.
      tableGame.updateSettings({ ...RANKED_FIXED_SETTINGS, difficulty: safeDifficulty });
      const tournamentHands = tournamentLengthForKey(config && config.tournamentKey);
      tableGame.setRankedMode(true, socket.data.user.id, tournamentHands);
    } else if (wantsRumble) {
      // Same discipline as ranked - stack/blinds/shot clock/seat count are
      // fixed (RUMBLE_FIXED_SETTINGS), never trusted from the client. The
      // bot difficulty is still the player's own choice, same as unranked.
      tableGame.updateSettings({ ...RUMBLE_FIXED_SETTINGS, difficulty: safeDifficulty, rumbleMode: true });
      tableGame.setRankedMode(false, null);
    } else {
      tableGame.updateSettings({ ...config, difficulty: safeDifficulty });
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
