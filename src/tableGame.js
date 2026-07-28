import { EventEmitter } from "node:events";
import { Hand } from "./hand.js";
import { getEasyAction } from "./bots/easyBot.js";
import { getMediumAction } from "./bots/mediumBot.js";
import { getHardAction } from "./bots/hardBot.js";
import { getExpertAction } from "./bots/expertBot.js";
import { getDrunkAction } from "./bots/drunkBot.js";
import { getBluffAction } from "./bots/bluffBot.js";
import { getRockAction } from "./bots/rockBot.js";
import { getManiacAction } from "./bots/maniacBot.js";
import { describeScore, bestHand, CATEGORY } from "./handEvaluator.js";
import { computeAllInEquity } from "./equity.js";
import { rankName } from "./deck.js";
import { xpForHand } from "./rankTiers.js";
import { pickLine } from "./botDialogue.js";
import { computeHandCoinsDelta, HAND_COINS_REWARD } from "./coins.js";
import { POWER_UPS_CATALOG, POWER_UP_HANDLERS, findPowerUp } from "./powerUps.js";
import { decidePowerUpUse } from "./rumbleBotAI.js";
import { RUMBLE_HANDS_TOTAL, RUMBLE_WIN_COINS_REWARD } from "./rumbleConfig.js";
import { TOURNAMENT_ROUND_HANDS_TOTAL, TOURNAMENT_ROUNDS_TOTAL } from "./tournamentConfig.js";

const BOT_NAMES = [
  "James", "Victoria", "Marcus", "Isabella",
  "Sebastian", "Charlotte", "Julian", "Anastasia",
];

// Experimental difficulties that only ever make sense heads-up (Drunk,
// Bluffer, and these two) - forced to a 2-player table regardless of what
// the client's Game Config says, both here (so constructing a TableGame
// directly always seats the right table) and again in server.js's
// updateSettings handler (so a tampered client request can't override it).
const HEADS_UP_ONLY_DIFFICULTIES = new Set(["drunk", "bluffer", "rock", "maniac"]);

// The Boardroom: one multi-bot table seating this fixed cast of six original
// characters (see src/botDialogue.js for each one's dialogue bank), sharing
// an existing decision algorithm (Hard's) - the character work here is
// entirely in dialogue identity, not a new decision AI per seat. Each
// character's `key` doubles as both its bot id and its dialogue persona key,
// so seat label, avatar, and dialogue can never drift out of sync.
const BOARDROOM_CHARACTERS = [
  { key: "tycoon", name: "The Tycoon" },
  { key: "schemer", name: "The Schemer" },
  { key: "conspiracy", name: "The Conspiracy Guy" },
  { key: "socialite", name: "The Socialite" },
  { key: "veteran", name: "The Veteran" },
  { key: "newcomer", name: "The Newcomer" },
];

const STREETS_ORDER = ["preflop", "flop", "turn", "river"];
const STREET_BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };

// TableGame extends EventEmitter rather than reaching into a module-scoped
// `io` directly, so it can be reused across many concurrent sessions (each
// with its own TableGame instance): 'stateChanged'/'botTurn'/'handComplete'/
// 'paused'/'resumed' are internal lifecycle events - a separate wiring layer
// (SessionRegistry) is the only code that actually calls io.to(...).emit(...),
// keyed off these events, so TableGame itself never needs to know whether
// it's being driven by one lone bot game or a room full of real people.
class TableGame extends EventEmitter {
  constructor(config = {}) {
    super();
    this.startingStack = config.startingStack || 1000;
    this.smallBlind = config.smallBlind || 10;
    this.bigBlind = config.bigBlind || 20;
    this.minRaise = this.bigBlind;
    // Set before building the player list below - _buildSoloPlayers reads
    // this.difficulty to force the right seat count for heads-up-only bots
    // and The Boardroom, regardless of what numPlayers was requested.
    this.difficulty = config.difficulty || 'easy';
    this.shotClockSeconds = config.shotClockSeconds || 0;

    // Room-mode games (config.roomMode) start with no seated players at all -
    // the host and each joiner are seated explicitly via addPlayer() as they
    // arrive, rather than the solo model's single hardcoded "You" plus a
    // fixed bot count.
    this.roomMode = !!config.roomMode;
    if (this.roomMode) {
      this.players = [];
    } else {
      const numBotsRequested = config.numPlayers !== undefined ? config.numPlayers - 1 : 5;
      this.players = this._buildSoloPlayers(numBotsRequested);
    }
    this.assignSeats();

    this.dealerIndex = this._initialDealerIndex();
    this.hand = null;
    this.handHistory = [];
    this.dealingNewHand = false;
    this.botTimeout = null;
    // Chat lines already used this hand, so a bot never repeats itself
    // within one hand - reset at the start of every startNewHand(). The
    // Boardroom's "exchange" reaction (see _speakBotChat) schedules its
    // own short-delay timer, tracked separately so it can be cancelled the
    // same way botTimeout is (a new hand starting, or the game disposing).
    this._usedDialogueLines = new Set();
    this._reactionTimeout = null;
    this.gameStarted = false;
    this.handCount = 0;
    this.resetBalanceEachHand = false;
    this.isPaused = false;
    this.turboMode = false;
    // Ranked mode: XP is only ever earned/lost when both are set, and userId
    // is resolved server-side from the authenticated socket - never trusted
    // from client input - so a logged-out visitor can never write XP.
    this.ranked = false;
    this.userId = null;
    // 0 = a single-hand ranked session (always ends after hand 1). > 0 = a
    // tournament of that many hands, ending early on a bust instead.
    this.rankedTournamentHandsTotal = 0;
    this.rankedTournamentHandsPlayed = 0;
    // Rumble: regular poker plus power-ups, fixed 5-hand tournament, whoever
    // has the most chips at the end wins. rumblePowerUps is assigned once,
    // the first time startNewHand() runs in a rumble session (see
    // _assignRumblePowerUps), and persists unused/used across every
    // subsequent hand in the session - never re-dealt per hand.
    this.rumbleMode = !!config.rumbleMode;
    this.rumblePowerUps = new Map(); // playerId -> { key, used }
    this.rumbleHandsPlayed = 0;
    // Tournament: a durable multi-round run (see tournament_runs in
    // src/db.js) drives which round/difficulty this table is playing right
    // now - tournamentRunId/tournamentRoundNumber are set once per round via
    // setTournamentMode(), read back by handleHandComplete() to report the
    // round's outcome. Unlike rumblePowerUps above, nothing here persists
    // itself; src/sessionRegistry.js owns the actual DB read/write for the
    // run, TableGame only ever reports what happened in the round it just
    // played.
    this.tournamentMode = false;
    this.tournamentRunId = null;
    this.tournamentRoundNumber = 0;
    this.tournamentHandsPlayed = 0;
    // Separate from userId above on purpose: userId only ever exists for a
    // ranked session (XP is ranked-only), but coins are earned in every mode
    // - unranked, ranked, experimental alike - so this tracks "is the human
    // seat logged in right now" independent of ranked status. Same
    // never-trust-the-client resolution rule applies: set from the
    // authenticated socket server-side, never from client input.
    this.humanUserId = null;
    // Room mode's equivalent of humanUserId, generalized to many seats at
    // once: a real room can have several different logged-in accounts
    // seated simultaneously, unlike solo's single "You" seat. Maps a
    // player id (the seat's session id in room mode) to that account's
    // user id - populated via addPlayer's optional userId, resolved
    // server-side from the authenticated socket, same as humanUserId.
    this.playerUserIds = new Map();

    // Stats tracking
    this.stats = {
      handsPlayed: 0,
      handsWon: 0,
      totalWinnings: 0,
      biggestPot: 0,
      totalActions: 0,
      vpipActions: 0,
      vpipHands: 0,
      totalBets: 0,
      totalRaises: 0,
      totalCalls: 0,
      totalFolds: 0,
      totalChecks: 0,
      totalPotWon: 0,
      totalInvested: 0,
      netProfit: 0,
      showdownsSeen: 0,
      showdownsWon: 0,
      showdownWinnings: 0,
      nonShowdownWinnings: 0,
      biggestWin: 0,
      biggestLoss: 0,
      currentStreak: 0,
      pfrHands: 0,
      threeBetHands: 0,
      threeBetOpportunities: 0,
      allInHandsTracked: 0,
      cumulativeEVDollars: 0,
      luckDollars: 0,
    };
    // Per-hand transient flags, reset at the start of each hand
    this._humanVpipThisHand = false;
    this._pfrCountedThisHand = false;
    this._human3BetOppCountedThisHand = false;

    // Structured per-hand log for export (CSV/JSON)
    this.handLog = [];

    // Parallel to balanceHistory: cumulative all-in-equity expected value,
    // for the "EV line vs actual line" balance graph overlay. Only changes
    // on hands that were tracked (went to an all-in before the river) -
    // holds flat in between, same as a real poker tracker's EV graph.
    this.evHistory = [{ hand: 0, ev: this.startingStack }];

    // When the current session started, for hands/hour tracking
    this.sessionStart = Date.now();

    // Track last action for each player for display
    this.lastActions = {};

    // Structured per-street/per-action log for the current hand, used by the
    // hand replayer (requestHandAnalysis). Reset at the start of each hand.
    this.currentHandActions = [];
    this.streetSnapshots = [];

    // Balance history for live graph (tracks after every action/round)
    this.balanceHistory = [{ hand: 0, balance: this.startingStack }];

    // Bot customization settings
    this.botCustomization = {
      personality: 'TAG',
      aggression: 50,
      bluffFreq: 0.15,
      foldTo3bet: 0.65,
    };
  }

  assignSeats() {
    this.players.forEach((player, idx) => {
      player.seat = idx;
    });
  }

  // Marcus is always the dealer/first-actor for a fresh game - a
  // deliberate fixed identity to open with, rather than the default
  // dealerIndex 0 (which would otherwise be "You", since the human is
  // always seated first - see _buildSoloPlayers). Falls back to seat 0
  // when Marcus isn't actually seated (heads-up-only difficulties, The
  // Boardroom's own cast, room mode, or fewer than 3 bots at the table -
  // see BOT_NAMES), rather than throwing.
  _initialDealerIndex() {
    const idx = this.players.findIndex((p) => p.id === "Marcus");
    return idx >= 0 ? idx : 0;
  }

  // Builds the solo "You" + N bots player list, forcing the seat count for
  // heads-up-only difficulties (2 total) and The Boardroom (the full cast of
  // 6 + human) regardless of numBotsRequested - the same "server/table never
  // trusts the client-requested count" rule ranked's fixed settings already
  // apply, just for seat count on these difficulties instead. Used by both
  // the constructor and updateSettings so a fresh game and a settings change
  // can never seat these difficulties differently.
  _buildSoloPlayers(numBotsRequested) {
    let numBots = numBotsRequested;
    if (this.difficulty === 'boardroom') numBots = BOARDROOM_CHARACTERS.length;
    else if (HEADS_UP_ONLY_DIFFICULTIES.has(this.difficulty)) numBots = 1;

    const players = [
      { id: "You", stack: this.startingStack, type: "human", seat: 0, colorClass: "color-0" },
    ];
    for (let i = 0; i < numBots; i++) {
      const character = this.difficulty === 'boardroom' ? BOARDROOM_CHARACTERS[i] : null;
      players.push({
        id: character ? character.key : (BOT_NAMES[i] || `Bot ${i + 1}`),
        stack: this.startingStack,
        type: "bot",
        seat: i + 1,
        colorClass: `color-${(i % 5) + 1}`,
        displayName: character ? character.name : undefined,
      });
    }
    return players;
  }

  // Resolves which botDialogue.js persona bank a given bot id should speak
  // from. The Boardroom's persona keys are exactly its bot ids (see
  // BOARDROOM_CHARACTERS), so seat label, avatar, and dialogue can never
  // drift out of sync with each other. Every other difficulty has a single
  // table-wide persona (or 'sober', the default/normal voice).
  _personaForBot(botId) {
    if (this.difficulty === 'boardroom') {
      return BOARDROOM_CHARACTERS.some((c) => c.key === botId) ? botId : 'sober';
    }
    if (this.difficulty === 'drunk' || this.difficulty === 'rock' || this.difficulty === 'maniac') {
      return this.difficulty;
    }
    return 'sober';
  }

  // Looks up a player's chosen display name for hand-history text. Solo bots
  // and "You" already use a human-readable id directly (no .displayName set,
  // so this just falls back to the id unchanged) - this only actually
  // changes anything for room players, whose id is an opaque session string.
  _displayNameFor(id) {
    const player = this.players.find((p) => p.id === id);
    return (player && player.displayName) || id;
  }

  // 9-max, matching the existing solo Game Config's player-count range and
  // the shared client-side computeSeats(n) layout, which already supports
  // up to 9 seats around the felt.
  hasOpenSeat() {
    return this.players.length < 9;
  }

  // Room-mode only: seats one additional real human player without touching
  // anyone already seated - unlike updateSettings() (solo), which
  // destructively rebuilds the whole player list from a numPlayers count.
  // That's correct for solo's "restart with N bots" model and wrong for a
  // room, where seat occupancy is state a host might be mid-lobby about.
  addPlayer({ id, displayName, userId }) {
    if (!id || !this.hasOpenSeat()) return null;
    if (this.players.some((p) => p.id === id)) return this.players.find((p) => p.id === id);
    const seat = this.players.length;
    const player = {
      id, stack: this.startingStack, type: "human", seat,
      colorClass: `color-${(seat % 5) + 1}`, displayName: displayName || id,
    };
    this.players.push(player);
    if (userId) this.playerUserIds.set(id, userId);
    this.assignSeats();
    this.emit('stateChanged');
    return player;
  }

  // Room-mode settings update: intentionally narrower than updateSettings()
  // (solo) - only the blind/stack config a host can tweak between hands,
  // never a destructive rebuild of who's seated.
  updateRoomSettings(config) {
    if (config.smallBlind) this.smallBlind = config.smallBlind;
    if (config.bigBlind) this.bigBlind = config.bigBlind;
    this.minRaise = this.bigBlind;
    if (config.startingStack) this.startingStack = config.startingStack;
    this.emit('stateChanged');
  }

  // Total chips in the pot right now: everything locked in from completed
  // streets, plus whatever's been contributed so far on the current street.
  _potTotal() {
    if (!this.hand) return 0;
    let pot = 0;
    for (const v of this.hand.totalContributed.values()) pot += v;
    if (this.hand.currentRound) {
      for (const p of this.hand.currentRound.players) pot += p.contributed;
    }
    return pot;
  }

  // Records one action into the structured per-hand log (for the hand
  // replayer) and backfills a street snapshot for every street the action
  // just opened. Call this AFTER hand.applyAction() succeeds, passing the
  // street the action was actually taken on (captured before applying it).
  // Backfilling matters because an all-in can cascade straight from preflop
  // to the river in one synchronous call, skipping the flop/turn transitions
  // that would normally trigger a snapshot - once everyone's all-in no more
  // betting happens, so the pot total is identical across all those streets,
  // making it safe to reuse the current pot total for each backfilled entry.
  _recordAction(playerId, action, amount, prevStreet, facing) {
    this.currentHandActions.push({
      actor: playerId, action, amount: amount || 0, street: prevStreet,
      // What this player was actually facing at the moment of the decision -
      // needed later to grade the decision (pot odds for a call/fold, hand
      // strength context for a bet/raise) rather than just record what
      // happened. Undefined for callers that don't pass it (bots, today).
      potBefore: facing ? facing.potBefore : undefined,
      toCall: facing ? facing.toCall : undefined,
    });
    const newStreet = this.hand.currentStreetName();
    if (newStreet !== prevStreet) {
      const potNow = this._potTotal();
      const prevIdx = STREETS_ORDER.indexOf(prevStreet);
      const newIdx = STREETS_ORDER.indexOf(newStreet);
      for (let idx = prevIdx + 1; idx <= newIdx; idx++) {
        const streetName = STREETS_ORDER[idx];
        this.streetSnapshots.push({
          street: streetName,
          board: this.hand.board.slice(0, STREET_BOARD_LEN[streetName]),
          potAtStreetStart: potNow,
        });
      }
    }
  }

  // Picks a random still-seated bot to "say" a line from the given
  // botDialogue.js category (drawn from that bot's own persona bank - see
  // _personaForBot), and emits it as a 'botChat' event for SessionRegistry
  // to broadcast. A no-op if there are no bots at the table or the category
  // doesn't resolve to a line - never throws either way, so a chat flourish
  // can never take a real hand down with it. excludeSet (_usedDialogueLines)
  // keeps a bot from repeating itself within the same hand.
  _speakBotChat(category) {
    const bots = this.players.filter((p) => p.type === "bot");
    if (bots.length === 0) return;
    const speaker = bots[Math.floor(Math.random() * bots.length)];
    const text = pickLine(category, this._personaForBot(speaker.id), this._usedDialogueLines);
    if (!text) return;
    this._usedDialogueLines.add(text);
    this.emit("botChat", { playerId: speaker.id, text });

    // The Boardroom's "exchange" mechanic: a chance a different character
    // visibly reacts a couple seconds later, so lines read as characters
    // actually bouncing off each other rather than isolated one-liners.
    if (this.difficulty === "boardroom" && bots.length > 1 && Math.random() < 0.35) {
      const others = bots.filter((b) => b.id !== speaker.id);
      const reactor = others[Math.floor(Math.random() * others.length)];
      if (this._reactionTimeout) clearTimeout(this._reactionTimeout);
      this._reactionTimeout = setTimeout(() => {
        this._reactionTimeout = null;
        if (!this.hand || this.hand.complete) return; // table's moved on since this was scheduled
        const reactionText = pickLine("reaction", this._personaForBot(reactor.id), this._usedDialogueLines);
        if (!reactionText) return;
        this._usedDialogueLines.add(reactionText);
        this.emit("botChat", { playerId: reactor.id, text: reactionText });
      }, 1500 + Math.floor(Math.random() * 1000));
    }
  }

  // Unchanged behavior for every existing caller (every test, and the entire
  // solo/ranked path): resolves "the" human - solo/ranked games only ever
  // have exactly one - and delegates to getStateFor. Room-mode callers (real
  // multi-human games) always call getStateFor(viewerId) directly instead,
  // since there's no single "the human" to resolve there.
  getState() {
    const soloHumanId = this.players.find(p => p.type === "human")?.id ?? null;
    return this.getStateFor(soloHumanId);
  }

  // The per-viewer state a specific socket/player should see: only viewerId's
  // own hole cards are ever real pre-showdown (everyone else's, including
  // other real humans in a room, are masked) - revealed for everyone once the
  // hand completes, same as a real showdown. A viewerId that isn't actually
  // seated (a spectator) falls out for free: it never matches any player's
  // id, so it sees every hole card masked pre-showdown and only legalActions
  // stays null, since actingPlayerId() can never equal it either.
  // The viewer's own Rumble power-up, if any - deliberately never includes
  // other players' power-ups (the whole point is nobody knows what anyone
  // else has until they use it). null outside rumble mode or before one's
  // been assigned yet (before the session's first startNewHand() call).
  _yourRumblePowerUp(viewerId) {
    if (!this.rumbleMode || !viewerId) return null;
    const entry = this.rumblePowerUps.get(viewerId);
    if (!entry) return null;
    const def = findPowerUp(entry.key);
    if (!def) return null;
    return {
      key: def.key, name: def.name, icon: def.icon,
      description: def.description, needsTarget: def.needsTarget,
      used: entry.used,
    };
  }

  getStateFor(viewerId) {
    if (!this.hand) {
      return {
        gameStarted: this.gameStarted,
        handCount: this.handCount,
        stats: this.stats,
        resetBalanceEachHand: this.resetBalanceEachHand, turboMode: this.turboMode,
        players: this.players.map(p => ({
          id: p.id, type: p.type, seat: p.seat, stack: p.stack, colorClass: p.colorClass,
          contributed: 0, folded: false, holeCards: [], active: false, displayName: p.displayName || p.id,
        })),
  street: "", board: [], pot: 0, actingId: null,
        legalActions: null, complete: false, results: null,
        handHistory: this.handHistory,
        smallBlind: this.smallBlind, bigBlind: this.bigBlind,
        shotClockSeconds: this.shotClockSeconds,
        sbId: null, bbId: null,
        isPaused: !!this.isPaused,
        yourHandDescription: "",
        sessionStart: this.sessionStart || null,
        ranked: this.ranked,
        rumbleMode: this.rumbleMode,
        rumbleHandsPlayed: this.rumbleHandsPlayed,
        rumbleHandsTotal: RUMBLE_HANDS_TOTAL,
        yourPowerUp: this._yourRumblePowerUp(viewerId),
        tournamentMode: this.tournamentMode,
        tournamentRoundNumber: this.tournamentRoundNumber,
        tournamentRoundsTotal: TOURNAMENT_ROUNDS_TOTAL,
        tournamentHandsPlayed: this.tournamentHandsPlayed,
        tournamentHandsTotal: TOURNAMENT_ROUND_HANDS_TOTAL,
        viewerId,
      };
    }

    const playerStates = this.players.map((p) => {
      const isFolded = this.hand.folded.has(p.id);
      const stack = this.hand.stacks.get(p.id) ?? p.stack;
      const contributed = this.hand.totalContributed.get(p.id) ?? 0;
      let hole = null;
      if (this.hand.complete || p.id === viewerId) {
        hole = this.hand.holeCards.get(p.id) || [];
      } else {
        hole = [{ rank: 0, suit: "" }, { rank: 0, suit: "" }];
      }
      return {
        id: p.id, type: p.type, seat: p.seat, stack, contributed, colorClass: p.colorClass,
        folded: isFolded, isDealer: false, displayName: p.displayName || p.id,
        holeCards: hole, active: this.hand.actingPlayerId() === p.id && !this.hand.complete,
      };
    });

    const pot = this._potTotal();

    let legalActions = null;
    let actingId = this.hand.actingPlayerId();
    if (viewerId && actingId === viewerId && !this.hand.complete) {
      const leg = this.hand.legalActions(viewerId);
      if (leg) {
        legalActions = {
          fold: leg.fold, check: leg.check, call: leg.call,
          callAmount: leg.callAmount, bet: leg.bet, raise: leg.raise,
          minRaiseTo: leg.minRaiseTo, maxRaiseTo: leg.maxRaiseTo,
          // The street's current total bet level (this.hand.currentRound.
          // currentBet) - callAmount above is deliberately the INCREMENTAL
          // amount the viewer themselves needs to add (standard poker
          // convention: what actually leaves their stack), which can look
          // surprisingly small if they'd already put in a lot this street
          // from their own earlier raise. currentBet lets the client show
          // "Call $20 (to $500)" so that's clear without changing what the
          // button itself actually charges.
          currentBet: this.hand.currentRound.currentBet,
        };
      }
    }

    let results = null;
    if (this.hand.complete && this.hand.result) {
      results = {
        payouts: Object.fromEntries(this.hand.result.payouts),
        showdown: this.hand.result.showdown ? {
          results: this.hand.result.showdown.results.map(r => ({
            id: r.id, description: describeScore(r.score), score: r.score,
          })),
        } : null,
      };
    }

    let yourHandDescription = "";
    if (viewerId) {
      const hole = this.hand.holeCards.get(viewerId) || [];
      if (hole.length === 2 && this.hand.board.length >= 3) {
        try {
          const best = bestHand([...hole, ...this.hand.board]);
          yourHandDescription = describeScore(best.score);
        } catch (e) {}
      }
    }

    return {
      street: this.hand.currentStreetName(), board: this.hand.board, pot,
      players: playerStates, actingId, legalActions, complete: this.hand.complete,
      results, handHistory: this.handHistory, gameStarted: this.gameStarted,
      handCount: this.handCount, smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      shotClockSeconds: this.shotClockSeconds,
      sbId: this.hand.sbId, bbId: this.hand.bbId,
      stats: this.stats, resetBalanceEachHand: this.resetBalanceEachHand, turboMode: this.turboMode,
      lastActions: this.lastActions,
      balanceHistory: this.balanceHistory,
      evHistory: this.evHistory,
      isPaused: !!this.isPaused,
      yourHandDescription,
      sessionStart: this.sessionStart || null,
      ranked: this.ranked,
      rumbleMode: this.rumbleMode,
      rumbleHandsPlayed: this.rumbleHandsPlayed,
      rumbleHandsTotal: RUMBLE_HANDS_TOTAL,
      yourPowerUp: this._yourRumblePowerUp(viewerId),
      frozenPlayerId: this.hand.currentRound ? this.hand.currentRound.frozenPlayerId : null,
      tournamentMode: this.tournamentMode,
      tournamentRoundNumber: this.tournamentRoundNumber,
      tournamentRoundsTotal: TOURNAMENT_ROUNDS_TOTAL,
      tournamentHandsPlayed: this.tournamentHandsPlayed,
      tournamentHandsTotal: TOURNAMENT_ROUND_HANDS_TOTAL,
      viewerId,
    };
  }

  // Shuffles the power-up catalog and hands one to each currently-seated
  // player, unique (no duplicates) as long as there are at least as many
  // catalog entries as players - RUMBLE_FIXED_SETTINGS forces exactly 6
  // players against a catalog bigger than 6, so every session gets a random
  // subset rather than the exact same 6 every time. If ever seated with more
  // players than catalog entries, cycles back through the catalog rather
  // than leaving anyone without a power-up. Called once per session, the
  // first time startNewHand() runs while rumbleMode is on - never re-dealt
  // per hand.
  _assignRumblePowerUps() {
    const shuffled = [...POWER_UPS_CATALOG];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    this.players.forEach((p, idx) => {
      const def = shuffled[idx % shuffled.length];
      this.rumblePowerUps.set(p.id, { key: def.key, used: false });
    });
  }

  // Activates playerId's (unused) Rumble power-up on their own turn - a
  // side-channel action, independent of and alongside their normal
  // fold/check/call/bet/raise decision (which is submitted separately, via
  // applyPlayerAction, same turn). Dispatches to the matching handler in
  // src/powerUps.js, then broadcasts a reveal everyone sees (just the
  // power-up's identity, per the "nobody knows what you have until you use
  // it" rule) plus, separately, any private info only the activator learns.
  applyPowerUp(playerId, target) {
    if (!this.rumbleMode || !this.hand || this.hand.complete || this.isPaused) {
      return { ok: false, error: "Not available right now." };
    }
    if (this.hand.actingPlayerId() !== playerId) {
      return { ok: false, error: "You can only use your power-up on your own turn." };
    }
    const entry = this.rumblePowerUps.get(playerId);
    if (!entry || entry.used) {
      return { ok: false, error: "No power-up available." };
    }
    const def = findPowerUp(entry.key);
    const handler = POWER_UP_HANDLERS[entry.key];
    if (!def || !handler) {
      return { ok: false, error: "Unknown power-up." };
    }
    const result = handler(this, this.hand, playerId, target) || {};
    if (result.error) {
      return { ok: false, error: result.error };
    }
    entry.used = true;
    this.emit("powerUpActivated", {
      playerId, key: def.key, name: def.name, icon: def.icon,
      target: target || null,
      ...(result.revealPayload || {}),
    });
    if (result.privateInfo) {
      this.emit("powerUpPrivateInfo", { playerId, ...result.privateInfo });
    }
    this.handHistory.push(`${this._displayNameFor(playerId)} used ${def.name}`);
    this.emit("stateChanged");
    return { ok: true };
  }

  startNewHand() {
    // A rumble tournament is always exactly RUMBLE_HANDS_TOTAL hands - once
    // that many have been played, no further hand is dealt (the client
    // shows the tournament-complete results screen instead of a "Next
    // Hand"/"Continue" affordance at that point).
    if (this.rumbleMode && this.rumbleHandsPlayed >= RUMBLE_HANDS_TOTAL) return;
    if (this.rumbleMode && this.rumblePowerUps.size === 0) this._assignRumblePowerUps();
    // Same guard for a Tournament round: once its TOURNAMENT_ROUND_HANDS_TOTAL
    // hands are played, tournamentMode stays on (only cleared by
    // updateSettings()'s clean-slate reset or an explicit exit) so the
    // client can still render "this round is over" - but nothing should be
    // able to deal an 11th hand into that same round, even a stray "Next
    // Hand" click racing ahead of the round-result modal actually showing.
    if (this.tournamentMode && this.tournamentHandsPlayed >= TOURNAMENT_ROUND_HANDS_TOTAL) return;
    if (this.botTimeout) clearTimeout(this.botTimeout);
    if (this._reactionTimeout) clearTimeout(this._reactionTimeout);
    this._reactionTimeout = null;
    this._usedDialogueLines = new Set();
    this._humanVpipThisHand = false;
    this._pfrCountedThisHand = false;
    this._human3BetOppCountedThisHand = false;
    this._handStartedAt = Date.now(); // for ranked_seconds_played on completion

    if (this.resetBalanceEachHand) {
      for (const p of this.players) p.stack = this.startingStack;
    } else {
      for (const p of this.players) {
        if (p.stack <= 0) p.stack = this.startingStack;
      }
    }

    this.handCount++;
    const handPlayers = [...this.players]
      .filter(p => p.stack > 0)
      .sort((a, b) => a.seat - b.seat)
      .map(p => ({ id: p.id, stack: p.stack }));

    if (handPlayers.length < 2) {
      for (const p of this.players) p.stack = this.startingStack;
      const resetPlayers = [...this.players].sort((a, b) => a.seat - b.seat).map(p => ({ id: p.id, stack: p.stack }));
      this.hand = new Hand({ players: resetPlayers, minRaise: this.minRaise, smallBlind: this.smallBlind, bigBlind: this.bigBlind, dealerIndex: this.dealerIndex });
    } else {
      this.hand = new Hand({ players: handPlayers, minRaise: this.minRaise, smallBlind: this.smallBlind, bigBlind: this.bigBlind, dealerIndex: this.dealerIndex });
    }

    this.handHistory.push(`--- Hand #${this.handCount} ---`);
    this.handHistory.push(`${this._displayNameFor(this.hand.sbId)} posts small blind ${this.smallBlind} (SB)`);
    this.handHistory.push(`${this._displayNameFor(this.hand.bbId)} posts big blind ${this.bigBlind} (BB)`);
    this.dealingNewHand = false;
    this.lastActions = {};

    this.currentHandActions = [];
    this.streetSnapshots = [{ street: "preflop", board: [], potAtStreetStart: this._potTotal() }];

    this.checkBotTurn();
    this.emit('stateChanged');
  }

  // Wraps the "begin a fresh session" transition (isPaused reset, gameStarted
  // flag, first hand dealt) into one method so every caller - solo play today,
  // room hosts later - shares exactly one start-of-game code path.
  startGame() {
    this.isPaused = false;
    this.gameStarted = true;
    this.startNewHand(); // emits 'stateChanged' itself
  }

  applyPlayerAction(playerId, action, amount) {
    if (!this.hand || this.hand.complete || this.isPaused) return false;
    if (this.hand.actingPlayerId() !== playerId) return false;

    const prevStreet = this.hand.currentStreetName();
    const priorRaiseCount = this.hand.currentRound ? this.hand.currentRound.raiseCount : 0;
    // Captured BEFORE applying the action - this is what the player was
    // actually deciding against, needed for the hand analyzer's decision
    // grading (pot odds on a call/fold, pot size for a bet/raise heuristic).
    const legalBefore = this.hand.legalActions(playerId);
    const facing = { potBefore: this._potTotal(), toCall: legalBefore ? legalBefore.callAmount : 0 };
    try {
      this.hand.applyAction(playerId, action, amount);
      const amtStr = amount ? ` ${amount}` : "";
      // Add street marker if street changed
      const newStreet = this.hand.currentStreetName();
      if (newStreet !== prevStreet) {
        this.handHistory.push(`--- ${newStreet.toUpperCase()} ---`);
      }
      this.handHistory.push(`${this._displayNameFor(playerId)}: ${action}${amtStr}`);
      // Track last action for display
      this.lastActions[playerId] = { action, amount: amount || 0, street: newStreet };
      this._recordAction(playerId, action, amount, prevStreet, facing);

      this.stats.totalActions++;
      if (action === "call") { this.stats.vpipActions++; this.stats.totalCalls++; }
      else if (action === "bet") { this.stats.vpipActions++; this.stats.totalBets++; }
      else if (action === "raise") { this.stats.vpipActions++; this.stats.totalRaises++; }
      else if (action === "fold") this.stats.totalFolds++;
      else if (action === "check") this.stats.totalChecks++;

      // True per-hand VPIP: did "You" voluntarily put money in preflop (excludes checking the BB option)
      if (playerId === "You" && prevStreet === "preflop" && (action === "call" || action === "bet" || action === "raise")) {
        this._humanVpipThisHand = true;
      }

      // Preflop 3-bet / PFR tracking, based on the raise count BEFORE this action was applied
      if (playerId === "You" && prevStreet === "preflop") {
        if (priorRaiseCount === 1 && !this._human3BetOppCountedThisHand) {
          this._human3BetOppCountedThisHand = true;
          this.stats.threeBetOpportunities++;
        }
        if (action === "raise") {
          if (priorRaiseCount === 0 && !this._pfrCountedThisHand) {
            this._pfrCountedThisHand = true;
            this.stats.pfrHands++;
          } else if (priorRaiseCount === 1) {
            this.stats.threeBetHands++;
          }
        }
      }

      for (const p of this.players) {
        if (this.hand.stacks.has(p.id)) p.stack = this.hand.stacks.get(p.id);
      }

      if (this.hand.complete) this.handleHandComplete();
      else this.checkBotTurn();
      this.emit('stateChanged');
      return true;
    } catch (err) {
      console.error("Action error:", err.message);
      return false;
    }
  }

  trackBalance() {
    const you = this.players.find(p => p.id === "You");
    if (you) {
      this.balanceHistory.push({ hand: this.handCount, balance: you.stack });
    }
    // Pushed every hand (not just all-in-tracked ones) so the EV line holds
    // flat between tracked hands and its x-axis stays aligned with balanceHistory.
    this.evHistory.push({ hand: this.handCount, ev: this.startingStack + this.stats.cumulativeEVDollars });
  }

  // Track balance after every hand completes (called in handleHandComplete)

  checkBotTurn() {
    if (!this.hand || this.hand.complete || this.isPaused) return;
    const actingId = this.hand.actingPlayerId();
    const actingPlayer = this.players.find(p => p.id === actingId);
    if (!actingPlayer || actingPlayer.type !== "bot") return;

    // Callers already clear this before calling in most paths (startNewHand,
    // setPaused, updateSettings, dispose), but checkBotTurn() can itself be
    // invoked more than once before its own scheduled timer fires (e.g. a
    // duplicate/rapid client event re-entering the same decision point) -
    // without this, that would stack two independent timers for the same
    // bot decision instead of replacing the pending one.
    if (this.botTimeout) clearTimeout(this.botTimeout);

    // Emit botTurn event so client can play a sound
    this.emit("botTurn", { playerId: actingId });

    // Delay between 2.5-4 seconds for smooth bot play (a flat 500ms in turbo mode)
    const delay = this.turboMode ? 500 : 2500 + Math.floor(Math.random() * 1500);
    this._lastBotDelay = delay; // exposed for tests

    this.botTimeout = setTimeout(() => {
      if (!this.hand || this.hand.complete || this.isPaused) return;
      if (this.hand.actingPlayerId() !== actingId) return;

      // Rumble: decide whether to fire the power-up first - a side-channel
      // action alongside (not instead of) the normal poker decision below,
      // same as a human using theirs then still submitting fold/check/call/
      // bet/raise. applyPowerUp() re-validates turn ownership/availability
      // itself, so this is safe even though we're already inside the "it's
      // actingId's turn" guard above.
      if (this.rumbleMode) {
        const entry = this.rumblePowerUps.get(actingId);
        if (entry && !entry.used) {
          const powerUpDecision = decidePowerUpUse(actingId, this.hand, entry.key, this);
          if (powerUpDecision && powerUpDecision.use) {
            this.applyPowerUp(actingId, powerUpDecision.target);
          }
        }
      }

      // Choose bot decision function based on difficulty
      let getAction;
      if (this.difficulty === 'hard') {
        getAction = getHardAction;
      } else if (this.difficulty === 'medium') {
        getAction = getMediumAction;
      } else if (this.difficulty === 'expert') {
        getAction = getExpertAction;
      } else if (this.difficulty === 'drunk') {
        getAction = getDrunkAction;
      } else if (this.difficulty === 'bluffer') {
        getAction = getBluffAction;
      } else if (this.difficulty === 'rock') {
        getAction = getRockAction;
      } else if (this.difficulty === 'maniac') {
        getAction = getManiacAction;
      } else if (this.difficulty === 'boardroom') {
        // The Boardroom's cast all share one decision algorithm - the
        // character work is entirely in dialogue identity, not per-seat AI.
        getAction = getHardAction;
      } else {
        getAction = getEasyAction;
      }

      let decision;
      if (this.difficulty === 'expert') {
        decision = getAction(actingId, this.hand, this.botCustomization);
      } else {
        decision = getAction(actingId, this.hand);
      }
      if (!decision) return;

      const prevStreet = this.hand.currentStreetName();
      const legalBefore = this.hand.legalActions(actingId);
      const facing = { potBefore: this._potTotal(), toCall: legalBefore ? legalBefore.callAmount : 0 };
      try {
        this.hand.applyAction(actingId, decision.action, decision.amount);
        const amtStr = decision.amount ? ` ${decision.amount}` : "";
        const newStreet = this.hand.currentStreetName();
        if (newStreet !== prevStreet) {
          this.handHistory.push(`--- ${newStreet.toUpperCase()} ---`);
        }
        this.handHistory.push(`${this._displayNameFor(actingId)}: ${decision.action}${amtStr}`);
        this.lastActions[actingId] = { action: decision.action, amount: decision.amount || 0, street: newStreet };
        this._recordAction(actingId, decision.action, decision.amount, prevStreet, facing);
        for (const p of this.players) {
          if (this.hand.stacks.has(p.id)) p.stack = this.hand.stacks.get(p.id);
        }
        // Occasional spontaneous banter, independent of anything remarkable
        // happening - keeps the table feeling alive across a hand's several
        // bot actions without firing on literally every single one.
        if (Math.random() < 0.24) this._speakBotChat('banter');
        this.emit('stateChanged');
        if (this.hand.complete) this.handleHandComplete();
        else this.checkBotTurn();
      } catch (err) {
        console.error("Bot error:", err);
        // The hand may already be complete at this point - the bot's own
        // action can have gone through fine, with the error actually coming
        // from something later (handleHandComplete's ranked-stats writes,
        // for example). legalActions() returns null once a hand is
        // complete, so a fallback action isn't just unnecessary here, it's
        // not even a coherent thing to attempt - there's no live decision
        // left to recover from.
        if (this.hand.complete) return;
        try {
          const leg = this.hand.legalActions(actingId);
          const fallback = leg.check ? "check" : "fold";
          this.hand.applyAction(actingId, fallback);
          this.handHistory.push(`${this._displayNameFor(actingId)}: ${fallback} (fb)`);
          this.lastActions[actingId] = { action: fallback, amount: 0, street: this.hand.currentStreetName() };
          this._recordAction(actingId, fallback, 0, prevStreet);
          this.emit('stateChanged');
          if (this.hand.complete) this.handleHandComplete();
          else this.checkBotTurn();
        } catch (e2) { console.error("Fallback error:", e2); }
      }
    }, delay);
  }

  // Applies Insurance/Bounty Hunter's payout bonuses in place, directly on
  // the SAME Map object handleHandComplete()'s own payout loop reads right
  // after this returns - both bonuses are sourced fresh, from the house,
  // never taken from another player's share of the pot. "Went all-in or
  // called a big bet" (Insurance's eligibility condition) is simplified to
  // "contributed at least half the starting stack this hand" - close enough
  // for a heuristic bonus without needing to replay this hand's full action
  // history to distinguish exactly how those chips went in.
  _applyRumblePayoutAdjustments() {
    if (!this.rumbleMode || !this.hand || !this.hand.result) return;
    const payouts = this.hand.result.payouts;
    const bigCommitment = this.startingStack * 0.5;

    if (this.hand._rumbleInsurancePlayers) {
      for (const playerId of this.hand._rumbleInsurancePlayers) {
        const contributed = this.hand.totalContributed.get(playerId) || 0;
        const payout = payouts.get(playerId) || 0;
        const lost = Math.max(0, contributed - payout);
        if (contributed >= bigCommitment && lost > 0) {
          payouts.set(playerId, payout + Math.floor(lost * 0.5));
        }
      }
    }
    if (this.hand._rumbleBountyPlayers) {
      for (const playerId of this.hand._rumbleBountyPlayers) {
        const contributed = this.hand.totalContributed.get(playerId) || 0;
        const payout = payouts.get(playerId) || 0;
        if (payout > contributed) {
          payouts.set(playerId, payout + Math.floor(payout * 0.25));
        }
      }
    }
    // Deadman's Fold: a FULL refund (not Insurance's 50%) of everything the
    // player put in this hand, but only if they actually ended up folding -
    // checked here at payout time rather than at fold time itself, same
    // deferred-resolution shape Insurance/Bounty Hunter already use.
    if (this.hand._rumbleDeadmansFoldPlayers) {
      for (const playerId of this.hand._rumbleDeadmansFoldPlayers) {
        if (!this.hand.folded.has(playerId)) continue;
        const contributed = this.hand.totalContributed.get(playerId) || 0;
        const payout = payouts.get(playerId) || 0;
        if (contributed > 0) payouts.set(playerId, payout + contributed);
      }
    }
  }

  handleHandComplete() {
    if (!this.hand || !this.hand.result) return;
    this._applyRumblePayoutAdjustments();
    this.stats.handsPlayed++;
    if (this._humanVpipThisHand) this.stats.vpipHands++;

    let youWon = false;
    for (const [id, payout] of this.hand.result.payouts) {
      const p = this.players.find(pl => pl.id === id);
      if (p) {
        p.stack += payout;
        if (payout > 0) {
          this.handHistory.push(`${this._displayNameFor(id)} wins ${payout}`);
          if (id === "You") {
            youWon = true;
            this.stats.totalWinnings += payout;
            this.stats.totalPotWon += payout;
            if (this.hand.result.showdown) this.stats.showdownWinnings += payout;
            else this.stats.nonShowdownWinnings += payout;
          }
        }
      }
    }
    if (youWon) this.stats.handsWon++;

    if (this.hand.result.pots) {
      const totalPot = this.hand.result.pots.reduce((s, pot) => s + pot.amount, 0);
      if (totalPot > this.stats.biggestPot) this.stats.biggestPot = totalPot;
    }

    const youDealtIn = this.hand.order.includes("You");
    if (youDealtIn && this.hand.result.showdown && !this.hand.folded.has("You")) {
      this.stats.showdownsSeen++;
      if ((this.hand.result.payouts.get("You") || 0) > 0) this.stats.showdownsWon++;
    }

    // Track total invested: actual $ "You" contributed to this hand's pots
    // (not a stack-deficit heuristic, which breaks under resetBalanceEachHand)
    const youContributed = this.hand.totalContributed.get("You") || 0;
    const youPayout = this.hand.result.payouts.get("You") || 0;
    this.stats.totalInvested += youContributed;
    this.stats.netProfit = this.stats.totalWinnings - this.stats.totalInvested;

    // Biggest win/loss and current streak (0 net - e.g. "You" wasn't dealt into this hand - leaves these unchanged)
    const youNetThisHand = youPayout - youContributed;
    if (youNetThisHand > this.stats.biggestWin) this.stats.biggestWin = youNetThisHand;
    if (youNetThisHand < this.stats.biggestLoss) this.stats.biggestLoss = youNetThisHand;
    if (youNetThisHand > 0) this.stats.currentStreak = this.stats.currentStreak >= 0 ? this.stats.currentStreak + 1 : 1;
    else if (youNetThisHand < 0) this.stats.currentStreak = this.stats.currentStreak <= 0 ? this.stats.currentStreak - 1 : -1;

    // Ranked XP: only for a logged-in, ranked session, and only for a hand
    // "You" were actually dealt into. Whether it's a win or a loss is the
    // same payout>0 definition already used for the handsWon stat above
    // (youWon); the XP *magnitude* scales with youNetThisHand - the size of
    // YOUR OWN actual win/loss - rather than the hand's total pot size.
    // Pot size used to be the scaling basis, but that let a hand you folded
    // out of cheaply (a tiny loss for you) get inflated XP just because the
    // remaining players kept battling and built a huge pot after you were
    // already out, and conversely undercounted a big multi-way win where
    // your own profit (pot minus what you put in) exceeds your own stake.
    if (this.ranked && this.userId && youDealtIn) {
      const xpDelta = xpForHand(this.difficulty, youWon, Math.abs(youNetThisHand), this.startingStack);
      this.emit('xpEarned', { userId: this.userId, delta: xpDelta });

      // Lifetime ranked stats (profile page) - a separate event since it's a
      // different persisted table than XP, but computed from the exact same
      // per-hand numbers already gathered above. potSize here is purely
      // informational (not used for XP scaling above - see the comment
      // block on this whole branch).
      const potSize = this.hand.result.pots ? this.hand.result.pots.reduce((s, pot) => s + pot.amount, 0) : 0;
      const reachedShowdown = !!(this.hand.result.showdown && !this.hand.folded.has("You"));
      this.emit('rankedHandComplete', {
        userId: this.userId,
        won: youWon,
        contributed: youContributed,
        payout: youPayout,
        potSize,
        showdown: reachedShowdown,
        showdownWon: reachedShowdown && youPayout > 0,
        elapsedSeconds: (Date.now() - (this._handStartedAt || Date.now())) / 1000,
      });
    }

    // Coins: unlike XP above, this fires for a logged-in player in solo
    // unranked/experimental play only - Ranked is a pure skill ladder now,
    // no coins involved at all, so it's deliberately excluded here rather
    // than given a bonus amount. humanUserId is independent of the
    // ranked-only userId above for this reason. Rumble is excluded too - its
    // reward structure is the 5-hand tournament outcome itself, not a
    // per-hand coin trickle, and its difficulty isn't one of the
    // Easy/Medium/Hard/Expert tiers computeHandCoinsDelta expects anyway.
    // Tournament mode is excluded for the same reason as Rumble - its reward
    // is the tier's entry-fee/payout economy (see the tournamentMode block
    // below), not a per-hand trickle on top of it.
    //
    // The reward is keyed by bot difficulty (see computeHandCoinsDelta) -
    // Easy/Medium/Hard/Expert pay progressively more for a win, the
    // experimental personalities pay Easy's rate, and any loss costs a flat
    // 1 coin regardless of difficulty.
    if (this.humanUserId && youDealtIn && !this.ranked && !this.rumbleMode && !this.tournamentMode) {
      const { delta, tier } = computeHandCoinsDelta({
        difficulty: this.difficulty,
        won: youNetThisHand > 0,
      });
      this.emit('coinsEarned', { userId: this.humanUserId, delta, tier });
    }
    // Room mode's equivalent - potentially several logged-in accounts at
    // once, so every seat with a known userId that was actually dealt into
    // this hand gets its own coinsEarned event (playerUserIds is always
    // empty in solo mode, so this is a no-op there - never double-pays the
    // humanUserId case above). Kept on the flat reward for now - there's no
    // per-seat difficulty/result tracking for arbitrary room players yet.
    for (const [playerId, userId] of this.playerUserIds) {
      if (this.hand.order.includes(playerId)) {
        this.emit('coinsEarned', { userId, delta: HAND_COINS_REWARD, tier: null });
      }
    }

    // Ranked session/tournament progression: a single-hand session always
    // ends after this one hand; a tournament ends once its hand count is
    // reached OR "You" bust (can't cover the next big blind) - whichever
    // comes first. Reset ranked state immediately so nothing can accidentally
    // keep going as "ranked" past this point.
    if (this.ranked) {
      this.rankedTournamentHandsPlayed++;
      const you = this.players.find((p) => p.id === "You");
      const bustedOut = !!you && you.stack < this.bigBlind;
      const isTournament = this.rankedTournamentHandsTotal > 0;
      const tournamentDone = isTournament && this.rankedTournamentHandsPlayed >= this.rankedTournamentHandsTotal;
      if (bustedOut || tournamentDone || !isTournament) {
        this.emit('rankedSessionComplete', { bustedOut, handsPlayed: this.rankedTournamentHandsPlayed });
        this.ranked = false;
        this.userId = null;
        this.rankedTournamentHandsTotal = 0;
        this.rankedTournamentHandsPlayed = 0;
      }
    }

    // Rumble tournament progression: always exactly RUMBLE_HANDS_TOTAL hands
    // (never bust-ends-it-early like ranked, and never client-configurable -
    // see src/rumbleConfig.js). Once the last hand's payouts above have
    // landed in every player's stack, declare whoever has the most chips
    // the winner (co-declared on an exact tie - no tiebreaker for v1).
    // rumbleMode is deliberately left on afterward (unlike ranked resetting
    // this.ranked) so the client can still render this as "a completed
    // rumble session" - updateSettings() is what actually resets it, the
    // same clean-slate reset every other mode already goes through when a
    // brand-new game starts.
    if (this.rumbleMode) {
      this.rumbleHandsPlayed++;
      if (this.rumbleHandsPlayed >= RUMBLE_HANDS_TOTAL) {
        const standings = this.players
          .map((p) => ({ id: p.id, displayName: p.displayName || p.id, stack: p.stack }))
          .sort((a, b) => b.stack - a.stack);
        const topStack = standings.length ? standings[0].stack : 0;
        const winners = standings.filter((s) => s.stack === topStack).map((s) => s.id);
        this.emit('rumbleSessionComplete', { standings, winners, handsPlayed: this.rumbleHandsPlayed });
        // Flat coin reward for winning the session (co-winners on a tie all
        // get paid, matching the tie-friendly winners list above) - nothing
        // is deducted on a loss, see RUMBLE_WIN_COINS_REWARD's own comment.
        if (this.humanUserId && winners.includes("You")) {
          this.emit('coinsEarned', { userId: this.humanUserId, delta: RUMBLE_WIN_COINS_REWARD, tier: 'rumble' });
        }
      }
    }

    // Tournament round progression: always exactly TOURNAMENT_ROUND_HANDS_TOTAL
    // hands per round. Unlike Rumble's "co-winners on a tie" v1 stance, this
    // uses a STRICT top-stack rule - real coins are non-refundably staked on
    // a tournament run, so an exact tie does not advance. TableGame itself
    // never touches the database for this - it just reports what happened;
    // src/sessionRegistry.js's tournamentRoundComplete listener owns the
    // actual tournament_runs read/write (advance the round, close out the
    // run, award the payout, grant reward cosmetics).
    if (this.tournamentMode) {
      this.tournamentHandsPlayed++;
      if (this.tournamentHandsPlayed >= TOURNAMENT_ROUND_HANDS_TOTAL) {
        const standings = this.players
          .map((p) => ({ id: p.id, displayName: p.displayName || p.id, stack: p.stack }))
          .sort((a, b) => b.stack - a.stack);
        const topStack = standings.length ? standings[0].stack : 0;
        const tiedForTop = standings.filter((s) => s.stack === topStack);
        const won = tiedForTop.length === 1 && tiedForTop[0].id === "You";
        this.emit('tournamentRoundComplete', {
          runId: this.tournamentRunId,
          roundNumber: this.tournamentRoundNumber,
          won,
          tied: tiedForTop.length > 1,
          standings,
        });
      }
    }

    // All-In Equity / luck-adjusted EV: only defined for hands where everyone
    // still live got all-in before the river (the remaining runout was pure
    // chance) and "You" were one of the participants. Skipped entirely for
    // Rumble hands - card-manipulation power-ups (Sleight of Hand today,
    // more in future waves) can discard a card that was already seen, and
    // this equity math has no concept of a "dead" card - see src/equity.js's
    // unseenPool(), which reconstructs "unseen" as the full deck minus
    // what's currently visible, with no memory of anything seen-then-
    // discarded. Rather than risk a silently-wrong luck stat, Rumble hands
    // just don't compute one at all.
    let allInEVThisHand = null;
    if (!this.rumbleMode && youDealtIn && this.hand.allInSnapshot) {
      const equity = computeAllInEquity(this.hand.allInSnapshot);
      const youEquity = equity["You"];
      if (youEquity !== undefined) {
        const potEligible = (this.hand.result.pots || [])
          .filter((pot) => pot.eligiblePlayerIds.includes("You"))
          .reduce((s, pot) => s + pot.amount, 0);
        allInEVThisHand = youEquity * potEligible - youContributed;
        this.stats.allInHandsTracked++;
        this.stats.cumulativeEVDollars += allInEVThisHand;
        this.stats.luckDollars += youNetThisHand - allInEVThisHand;
      }
    }

    // Structured per-hand record for export (CSV/JSON)
    if (youDealtIn) {
      const position = this.hand.sbId === "You" ? "SB" : this.hand.bbId === "You" ? "BB" :
        (this.hand.order[this.hand.dealerIndex] === "You" ? "BTN" : "other");
      let showdownDescription = null;
      if (this.hand.result.showdown) {
        const r = this.hand.result.showdown.results.find(r => r.id === "You");
        if (r) showdownDescription = describeScore(r.score);
      }
      this.handLog.push({
        handNumber: this.handCount,
        timestamp: Date.now(),
        position,
        holeCards: (this.hand.holeCards.get("You") || []).map(c => `${rankName(c.rank)}${c.suit}`),
        board: this.hand.board.map(c => `${rankName(c.rank)}${c.suit}`),
        contributed: youContributed,
        payout: youPayout,
        net: youNetThisHand,
        wentToShowdown: !!(this.hand.result.showdown && !this.hand.folded.has("You")),
        showdownDescription,
        potSize: this.hand.result.pots ? this.hand.result.pots.reduce((s, p) => s + p.amount, 0) : 0,
        numPlayersDealt: this.hand.order.length,
        allInEV: allInEVThisHand,
      });
    }

    // Bot chat reactions to how the hand actually went. bigWin/bigLoss are
    // mutually exclusive (they're opposite ends of the same net-result
    // check), but a caughtBluff or premiumHand line can also fire in the
    // same hand as one of them - a big pot that was also a caught bluff is
    // a perfectly normal thing to happen at once.
    if (youDealtIn) {
      const bigThreshold = this.startingStack * 0.2;
      if (youNetThisHand <= -bigThreshold) this._speakBotChat("bigLoss");
      else if (youNetThisHand >= bigThreshold) this._speakBotChat("bigWin");

      if (this.hand.result.showdown && !this.hand.folded.has("You")) {
        const youWasAggressor = this.currentHandActions.some((a) => a.actor === "You" && (a.action === "bet" || a.action === "raise"));
        const youShowdown = this.hand.result.showdown.results.find((r) => r.id === "You");
        if (youWasAggressor && youPayout === 0 && youShowdown && youShowdown.score[0] <= CATEGORY.ONE_PAIR) {
          this._speakBotChat("caughtBluff");
        }

        // A premium hand got shown down - pocket aces, or quads-or-better
        // for anyone at the table, not just "You".
        const sawPremium = this.hand.result.showdown.results.some((r) => {
          if (r.score[0] >= CATEGORY.FOUR_OF_A_KIND) return true;
          const hole = this.hand.holeCards.get(r.id);
          return !!(hole && hole.length === 2 && hole[0].rank === 14 && hole[1].rank === 14);
        });
        if (sawPremium) this._speakBotChat("premiumHand");
      }
    }

    this.trackBalance();
    // Emit ripple effect event to clients
    this.emit("handComplete", { youWon });
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.emit('stateChanged');
  }

  setPaused(paused) {
    this.isPaused = !!paused;
    if (this.isPaused) {
      if (this.botTimeout) clearTimeout(this.botTimeout);
      this.emit('paused');
    } else {
      this.checkBotTurn();
      this.emit('resumed');
    }
    this.emit('stateChanged');
  }

  setTurboMode(turbo) {
    this.turboMode = !!turbo;
    this.emit('stateChanged');
  }

  // userId is the caller's responsibility to resolve safely (e.g. from the
  // authenticated socket, never straight from client-sent input) - this
  // method just stores whatever it's given and refuses to be "ranked" without
  // a user id to actually award XP to.
  setRankedMode(ranked, userId, tournamentHands = 0) {
    this.ranked = !!ranked && !!userId;
    this.userId = this.ranked ? userId : null;
    this.rankedTournamentHandsTotal = this.ranked ? Math.max(0, tournamentHands | 0) : 0;
    this.rankedTournamentHandsPlayed = 0;
    this.emit('stateChanged');
  }

  // runId/roundNumber are the caller's responsibility to resolve from the
  // durable tournament_runs row (src/sessionRegistry.js) - this just stores
  // them and resets the round's own hand counter to 0. Called from the
  // beginTournamentRound socket handler right before startGame(), same spot
  // setRankedMode is called from for a ranked session.
  setTournamentMode(on, { runId, roundNumber } = {}) {
    this.tournamentMode = !!on;
    this.tournamentRunId = this.tournamentMode ? runId : null;
    this.tournamentRoundNumber = this.tournamentMode ? roundNumber : 0;
    this.tournamentHandsPlayed = 0;
    this.emit('stateChanged');
  }

  // Clears tournament state immediately with no other side effects - called
  // when the player exits a tournament run mid-round (POST /api/tournament/
  // exit) so any hand still in flight just finishes as an ordinary,
  // non-tournament hand instead of handleHandComplete() trying to report a
  // round outcome into a run that's already been closed out.
  cancelTournamentMode() {
    this.tournamentMode = false;
    this.tournamentRunId = null;
    this.tournamentRoundNumber = 0;
    this.tournamentHandsPlayed = 0;
  }

  // Same resolution rule as setRankedMode's userId - caller resolves from
  // the authenticated socket, this just stores it. Called on every
  // updateSettings, ranked or not, so coins can be earned regardless of mode.
  setHumanUserId(userId) {
    this.humanUserId = userId || null;
  }

  setResetBalanceEachHand(reset) {
    this.resetBalanceEachHand = !!reset;
  }

  updateBotCustomization(patch) {
    if (patch) {
      this.botCustomization = {
        ...this.botCustomization,
        ...patch,
      };
    }
  }

  updateSettings(config) {
    const numBotsRequested = config.numPlayers ? config.numPlayers - 1 : this.players.length - 1;
    this.startingStack = config.startingStack || this.startingStack;
    this.smallBlind = config.smallBlind || this.smallBlind;
    this.bigBlind = config.bigBlind || this.bigBlind;
    this.minRaise = this.bigBlind;
    if (config.difficulty) this.difficulty = config.difficulty;
    // Same pattern as ranked: the server (server.js's updateSettings socket
    // handler) is responsible for forcing RUMBLE_FIXED_SETTINGS into config
    // before this ever runs, so rumbleMode here is just reading the flag,
    // not trusting the client for stack size/blinds/shot clock.
    this.rumbleMode = !!config.rumbleMode;
    // Unlike rumbleMode, tournamentMode is never read from config here at
    // all - it's only ever turned on via the dedicated setTournamentMode()
    // call, made right after updateSettings() by the beginTournamentRound
    // socket handler (server.js), never through the generic client-settings
    // path. This unconditional reset is what makes every updateSettings()
    // call - including a Tournament round's own - a genuine clean slate.
    this.tournamentMode = false;
    // config.shotClockSeconds ?? keeps 0 (no time limit) a real, settable
    // value instead of falling through to whatever it was before - unlike
    // the other fields above, "no limit" is a legitimate choice a caller can
    // make, not just an absent field.
    this.shotClockSeconds = config.shotClockSeconds !== undefined ? config.shotClockSeconds : this.shotClockSeconds;
    // Turbo is otherwise a session-level pacing preference that deliberately
    // survives updateSettings (see turbo.test.js) - a normal client settings
    // change never includes turboMode in its config, so this is a no-op for
    // that path. Ranked is the one caller that DOES pass it explicitly
    // (RANKED_FIXED_SETTINGS.turboMode: false), and it must actually stick:
    // "no turbo in ranked" is a promise made right on the ranked setup
    // screen, and previously nothing here ever enforced it, so turning
    // turbo on in an earlier unranked/experimental game would silently
    // carry the faster bot-turn pacing into a ranked session afterward.
    if (config.turboMode !== undefined) this.turboMode = !!config.turboMode;

    if (config.botCustomization) {
      this.botCustomization = {
        ...this.botCustomization,
        ...config.botCustomization,
      };
    }

    // Reset balance history on new settings
    this.balanceHistory = [{ hand: 0, balance: this.startingStack }];
    this.evHistory = [{ hand: 0, ev: this.startingStack }];

    if (this.botTimeout) clearTimeout(this.botTimeout);
    this.botTimeout = null;
    if (this._reactionTimeout) clearTimeout(this._reactionTimeout);
    this._reactionTimeout = null;
    this._usedDialogueLines = new Set();

    this.players = this._buildSoloPlayers(numBotsRequested);
    this.assignSeats();

    this.hand = null;
    this.handHistory = [];
    this.handCount = 0;
    this.gameStarted = false;
    this.dealingNewHand = false;
    this.stats = {
      handsPlayed: 0, handsWon: 0, totalWinnings: 0, biggestPot: 0,
      totalActions: 0, vpipActions: 0, vpipHands: 0, totalBets: 0, totalRaises: 0,
      totalCalls: 0, totalFolds: 0, totalChecks: 0, totalPotWon: 0, totalInvested: 0,
      netProfit: 0,
      showdownsSeen: 0, showdownsWon: 0, showdownWinnings: 0, nonShowdownWinnings: 0,
      biggestWin: 0, biggestLoss: 0, currentStreak: 0,
      pfrHands: 0, threeBetHands: 0, threeBetOpportunities: 0,
      allInHandsTracked: 0, cumulativeEVDollars: 0, luckDollars: 0,
    };
    this._humanVpipThisHand = false;
    this._pfrCountedThisHand = false;
    this._human3BetOppCountedThisHand = false;
    this.handLog = [];
    this.currentHandActions = [];
    this.streetSnapshots = [];
    this.sessionStart = Date.now();
    this.dealerIndex = this._initialDealerIndex();
    this.isPaused = false;
    // A fresh game always starts unranked - the caller re-applies ranked mode
    // (via setRankedMode) right after, if the player chose it, since starting
    // a new game via updateSettings is a clean-slate reset.
    this.ranked = false;
    this.userId = null;
    this.rankedTournamentHandsTotal = 0;
    this.rankedTournamentHandsPlayed = 0;
    // Same clean-slate reset for Rumble - a brand-new game (rumble or not)
    // always starts with a fresh, unassigned power-up set and hand count,
    // even if the previous game at this table was a just-completed rumble
    // session (see handleHandComplete()'s rumbleSessionComplete comment for
    // why rumbleMode itself isn't reset there).
    this.rumblePowerUps = new Map();
    this.rumbleHandsPlayed = 0;
    // tournamentMode itself is already reset above (never read from config);
    // this clears the rest of its state the same clean-slate way.
    this.tournamentRunId = null;
    this.tournamentRoundNumber = 0;
    this.tournamentHandsPlayed = 0;
    this.emit('stateChanged');
  }

  // Called by SessionRegistry when a session is evicted (long-disconnected,
  // or swept as an abandoned game). Stops the pending bot timer and detaches
  // every listener the registry wired up, so nothing keeps this instance (or
  // the registry's io reference it closed over) alive after eviction.
  dispose() {
    if (this.botTimeout) {
      clearTimeout(this.botTimeout);
      this.botTimeout = null;
    }
    if (this._reactionTimeout) {
      clearTimeout(this._reactionTimeout);
      this._reactionTimeout = null;
    }
    this.removeAllListeners();
  }
}

export { TableGame, BOT_NAMES, STREETS_ORDER, STREET_BOARD_LEN, HEADS_UP_ONLY_DIFFICULTIES, BOARDROOM_CHARACTERS };
