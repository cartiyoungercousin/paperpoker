import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { Hand } from "./src/hand.js";
import { getEasyAction } from "./src/bots/easyBot.js";
import { getMediumAction } from "./src/bots/mediumBot.js";
import { getHardAction } from "./src/bots/hardBot.js";
import { getExpertAction } from "./src/bots/expertBot.js";
import { describeScore, bestHand } from "./src/handEvaluator.js";
import { rankName } from "./src/deck.js";
import { computeAllInEquity, estimateEquityVsUnknown } from "./src/equity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const BOT_NAMES = [
  "James", "Victoria", "Marcus", "Isabella",
  "Sebastian", "Charlotte", "Julian", "Anastasia",
];

const STREETS_ORDER = ["preflop", "flop", "turn", "river"];
const STREET_BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };

class TableGame {
  constructor(config = {}) {
    const numBots = config.numPlayers !== undefined ? config.numPlayers - 1 : 5;
    this.startingStack = config.startingStack || 1000;
    this.smallBlind = config.smallBlind || 10;
    this.bigBlind = config.bigBlind || 20;
    this.minRaise = this.bigBlind;
    this.difficulty = config.difficulty || 'easy';

    this.players = [
      { id: "You", stack: this.startingStack, type: "human", seat: 0, colorClass: "color-0" },
    ];
    for (let i = 0; i < numBots; i++) {
      this.players.push({
        id: BOT_NAMES[i] || `Bot ${i + 1}`,
        stack: this.startingStack,
        type: "bot",
        seat: i + 1,
        colorClass: `color-${(i % 5) + 1}`,
      });
    }
    this.assignSeats();

    this.dealerIndex = 0;
    this.hand = null;
    this.handHistory = [];
    this.dealingNewHand = false;
    this.botTimeout = null;
    this.gameStarted = false;
    this.handCount = 0;
    this.resetBalanceEachHand = false;
    this.isPaused = false;
    this.turboMode = false;

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
  _recordAction(playerId, action, amount, prevStreet) {
    this.currentHandActions.push({ actor: playerId, action, amount: amount || 0, street: prevStreet });
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

  getState() {
    if (!this.hand) {
      return {
        gameStarted: this.gameStarted,
        handCount: this.handCount,
        stats: this.stats,
        resetBalanceEachHand: this.resetBalanceEachHand, turboMode: this.turboMode,
        players: this.players.map(p => ({
          id: p.id, type: p.type, seat: p.seat, stack: p.stack, colorClass: p.colorClass,
          contributed: 0, folded: false, holeCards: [], active: false,
        })),
  street: "", board: [], pot: 0, actingId: null,
        legalActions: null, complete: false, results: null,
        handHistory: this.handHistory,
        smallBlind: this.smallBlind, bigBlind: this.bigBlind,
        sbId: null, bbId: null,
        isPaused: !!this.isPaused,
        yourHandDescription: "",
        sessionStart: this.sessionStart || null,
      };
    }

    const playerStates = this.players.map((p) => {
      const isFolded = this.hand.folded.has(p.id);
      const stack = this.hand.stacks.get(p.id) ?? p.stack;
      const contributed = this.hand.totalContributed.get(p.id) ?? 0;
      let hole = null;
      if (this.hand.complete || p.id === "You") {
        hole = this.hand.holeCards.get(p.id) || [];
      } else {
        hole = [{ rank: 0, suit: "" }, { rank: 0, suit: "" }];
      }
      return {
        id: p.id, type: p.type, seat: p.seat, stack, contributed, colorClass: p.colorClass,
        folded: isFolded, isDealer: false,
        holeCards: hole, active: this.hand.actingPlayerId() === p.id && !this.hand.complete,
      };
    });

    const pot = this._potTotal();

    let legalActions = null;
    let actingId = this.hand.actingPlayerId();
    const humanId = this.players.find(p => p.type === "human")?.id;
    if (humanId && actingId === humanId && !this.hand.complete) {
      const leg = this.hand.legalActions(humanId);
      if (leg) {
        legalActions = {
          fold: leg.fold, check: leg.check, call: leg.call,
          callAmount: leg.callAmount, bet: leg.bet, raise: leg.raise,
          minRaiseTo: leg.minRaiseTo, maxRaiseTo: leg.maxRaiseTo,
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
    if (humanId) {
      const hole = this.hand.holeCards.get(humanId) || [];
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
      sbId: this.hand.sbId, bbId: this.hand.bbId,
      stats: this.stats, resetBalanceEachHand: this.resetBalanceEachHand, turboMode: this.turboMode,
      lastActions: this.lastActions,
      balanceHistory: this.balanceHistory,
      evHistory: this.evHistory,
      isPaused: !!this.isPaused,
      yourHandDescription,
      sessionStart: this.sessionStart || null,
    };
  }

  startNewHand() {
    if (this.botTimeout) clearTimeout(this.botTimeout);
    this._humanVpipThisHand = false;
    this._pfrCountedThisHand = false;
    this._human3BetOppCountedThisHand = false;

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
    this.handHistory.push(`${this.hand.sbId} posts small blind ${this.smallBlind} (SB)`);
    this.handHistory.push(`${this.hand.bbId} posts big blind ${this.bigBlind} (BB)`);
    this.dealingNewHand = false;
    this.lastActions = {};

    this.currentHandActions = [];
    this.streetSnapshots = [{ street: "preflop", board: [], potAtStreetStart: this._potTotal() }];

    this.checkBotTurn();
  }

  applyPlayerAction(playerId, action, amount) {
    if (!this.hand || this.hand.complete || this.isPaused) return false;
    if (this.hand.actingPlayerId() !== playerId) return false;

    const prevStreet = this.hand.currentStreetName();
    const priorRaiseCount = this.hand.currentRound ? this.hand.currentRound.raiseCount : 0;
    try {
      this.hand.applyAction(playerId, action, amount);
      const amtStr = amount ? ` ${amount}` : "";
      // Add street marker if street changed
      const newStreet = this.hand.currentStreetName();
      if (newStreet !== prevStreet) {
        this.handHistory.push(`--- ${newStreet.toUpperCase()} ---`);
      }
      this.handHistory.push(`${playerId}: ${action}${amtStr}`);
      // Track last action for display
      this.lastActions[playerId] = { action, amount: amount || 0, street: newStreet };
      this._recordAction(playerId, action, amount, prevStreet);

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

    // Emit botTurn event so client can play a sound
    io.emit("botTurn", { playerId: actingId });

    // Delay between 1-2 seconds for smooth bot play (50-150ms in turbo mode)
    const delay = this.turboMode ? 50 + Math.floor(Math.random() * 100) : 1000 + Math.floor(Math.random() * 1000);
    this._lastBotDelay = delay; // exposed for tests

    this.botTimeout = setTimeout(() => {
      if (!this.hand || this.hand.complete || this.isPaused) return;
      if (this.hand.actingPlayerId() !== actingId) return;

      // Choose bot decision function based on difficulty
      let getAction;
      if (this.difficulty === 'hard') {
        getAction = getHardAction;
      } else if (this.difficulty === 'medium') {
        getAction = getMediumAction;
      } else if (this.difficulty === 'expert') {
        getAction = getExpertAction;
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
      try {
        this.hand.applyAction(actingId, decision.action, decision.amount);
        const amtStr = decision.amount ? ` ${decision.amount}` : "";
        const newStreet = this.hand.currentStreetName();
        if (newStreet !== prevStreet) {
          this.handHistory.push(`--- ${newStreet.toUpperCase()} ---`);
        }
        this.handHistory.push(`${actingId}: ${decision.action}${amtStr}`);
        this.lastActions[actingId] = { action: decision.action, amount: decision.amount || 0, street: newStreet };
        this._recordAction(actingId, decision.action, decision.amount, prevStreet);
        for (const p of this.players) {
          if (this.hand.stacks.has(p.id)) p.stack = this.hand.stacks.get(p.id);
        }
        io.emit("gameState", this.getState());
        if (this.hand.complete) this.handleHandComplete();
        else this.checkBotTurn();
      } catch (err) {
        console.error("Bot error:", err);
        try {
          const leg = this.hand.legalActions(actingId);
          const fallback = leg.check ? "check" : "fold";
          this.hand.applyAction(actingId, fallback);
          this.handHistory.push(`${actingId}: ${fallback} (fb)`);
          this.lastActions[actingId] = { action: fallback, amount: 0, street: this.hand.currentStreetName() };
          this._recordAction(actingId, fallback, 0, prevStreet);
          io.emit("gameState", this.getState());
          if (this.hand.complete) this.handleHandComplete();
          else this.checkBotTurn();
        } catch (e2) { console.error("Fallback error:", e2); }
      }
    }, delay);
  }

  handleHandComplete() {
    if (!this.hand || !this.hand.result) return;
    this.stats.handsPlayed++;
    if (this._humanVpipThisHand) this.stats.vpipHands++;

    let youWon = false;
    for (const [id, payout] of this.hand.result.payouts) {
      const p = this.players.find(pl => pl.id === id);
      if (p) {
        p.stack += payout;
        if (payout > 0) {
          this.handHistory.push(`${id} wins ${payout}`);
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

    // All-In Equity / luck-adjusted EV: only defined for hands where everyone
    // still live got all-in before the river (the remaining runout was pure
    // chance) and "You" were one of the participants.
    let allInEVThisHand = null;
    if (youDealtIn && this.hand.allInSnapshot) {
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

    this.trackBalance();
    // Emit ripple effect event to clients
    io.emit("handComplete", { youWon });
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    io.emit("gameState", this.getState());
  }

  updateSettings(config) {
    const numBots = config.numPlayers ? config.numPlayers - 1 : this.players.length - 1;
    this.startingStack = config.startingStack || this.startingStack;
    this.smallBlind = config.smallBlind || this.smallBlind;
    this.bigBlind = config.bigBlind || this.bigBlind;
    this.minRaise = this.bigBlind;
    if (config.difficulty) this.difficulty = config.difficulty;

    // Apply bot customization if provided
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

    this.players = [
      { id: "You", stack: this.startingStack, type: "human", seat: 0, colorClass: "color-0" },
    ];
    for (let i = 0; i < numBots; i++) {
      this.players.push({
        id: BOT_NAMES[i] || `Bot ${i + 1}`,
        stack: this.startingStack,
        type: "bot",
        seat: i + 1,
        colorClass: `color-${(i % 5) + 1}`,
      });
    }
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
    this.dealerIndex = 0;
    this.isPaused = false;
  }
}

// Builds the payload for the hand replayer/analyzer: "You"'s hole cards, a
// best-hand description, and one entry per street with that street's board,
// the actions taken on it, and "You"'s equity at that point.
//
// Equity is computed two different ways depending on what's knowable:
//   - Exact (via computeAllInEquity): for streets at/after a real all-in
//     "You" were part of - hole cards are effectively revealed at that point,
//     so exact/Monte Carlo enumeration against the KNOWN opponent hands is
//     both possible and strictly more accurate.
//   - Estimated (via estimateEquityVsUnknown): everywhere else - opponents'
//     hole cards are genuinely unknown, so this is a Monte Carlo estimate
//     against however many opponents were still live at that street.
// No equity is computed for streets after "You" folded (nothing to compute -
// "You" were no longer eligible to win).
function buildHandAnalysis(tableGame) {
  const hand = tableGame.hand;
  if (!hand || !hand.complete) return null;

  const heroHoleCards = hand.holeCards.get("You") || [];
  let yourBestHandDescription = "";
  if (heroHoleCards.length === 2 && hand.board.length >= 3) {
    try {
      const best = bestHand([...heroHoleCards, ...hand.board]);
      yourBestHandDescription = describeScore(best.score);
    } catch (e) {}
  }

  const allInSnap = hand.allInSnapshot;
  const allInCoversYou = !!(allInSnap && allInSnap.participants.some((p) => p.id === "You"));

  const youFoldAction = tableGame.currentHandActions.find((a) => a.actor === "You" && a.action === "fold");
  const youFoldStreetIdx = youFoldAction ? STREETS_ORDER.indexOf(youFoldAction.street) : Infinity;

  const streetSnapshots = tableGame.streetSnapshots.map((snap) => {
    const streetIdx = STREETS_ORDER.indexOf(snap.street);
    const actions = tableGame.currentHandActions.filter((a) => a.street === snap.street);

    let equityAtStreet = null;
    let equityIsExact = false;
    if (heroHoleCards.length === 2 && streetIdx <= youFoldStreetIdx) {
      if (allInCoversYou && snap.board.length >= allInSnap.boardAtAllIn.length) {
        const equity = computeAllInEquity({ participants: allInSnap.participants, boardAtAllIn: snap.board });
        equityAtStreet = equity["You"] ?? null;
        equityIsExact = true;
      } else {
        const foldedBefore = new Set(
          tableGame.currentHandActions
            .filter((a) => a.action === "fold" && STREETS_ORDER.indexOf(a.street) < streetIdx)
            .map((a) => a.actor)
        );
        const numOpponents = hand.order.filter((id) => id !== "You" && !foldedBefore.has(id)).length;
        equityAtStreet = estimateEquityVsUnknown({ heroHoleCards, board: snap.board, numOpponents });
        equityIsExact = false;
      }
    }

    return {
      street: snap.street,
      board: snap.board,
      potAtStreetStart: snap.potAtStreetStart,
      actions,
      equityAtStreet,
      equityIsExact,
    };
  });

  return {
    handCount: tableGame.handCount,
    board: hand.board,
    holeCards: heroHoleCards,
    yourBestHandDescription,
    totalContributed: Object.fromEntries(hand.totalContributed),
    order: hand.order,
    pots: hand.result ? hand.result.pots : [],
    stacks: Object.fromEntries(hand.stacks),
    payouts: hand.result ? Object.fromEntries(hand.result.payouts) : {},
    streetSnapshots,
  };
}

export { TableGame, buildHandAnalysis };

const tableGame = new TableGame();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("gameState", tableGame.getState());
  socket.emit("tableInfo", {
    smallBlind: tableGame.smallBlind, bigBlind: tableGame.bigBlind, minRaise: tableGame.minRaise,
  });

  socket.on("playerAction", ({ action, amount }) => {
    if (tableGame.applyPlayerAction("You", action, amount)) {
      io.emit("gameState", tableGame.getState());
    }
  });

  socket.on("nextHand", () => {
    tableGame.startNewHand();
    io.emit("gameState", tableGame.getState());
  });

  // Bot customization
  socket.on("updateBotCustomization", (customization) => {
    if (customization) {
      tableGame.botCustomization = {
        ...tableGame.botCustomization,
        ...customization,
      };
    }
  });

  // Hand analysis request: return hand data for analysis
  socket.on("requestHandAnalysis", () => {
    const analysis = buildHandAnalysis(tableGame);
    if (analysis) socket.emit("handAnalysis", analysis);
  });

  socket.on("requestExport", () => {
    socket.emit("exportData", { handLog: tableGame.handLog, stats: tableGame.stats });
  });

  socket.on("startGame", () => {
    tableGame.isPaused = false;
    tableGame.gameStarted = true;
    tableGame.startNewHand();
    io.emit("gameState", tableGame.getState());
  });

  socket.on("setResetBalance", ({ reset }) => {
    tableGame.resetBalanceEachHand = reset;
  });

  socket.on("setTurboMode", ({ turbo }) => {
    tableGame.turboMode = !!turbo;
    io.emit("gameState", tableGame.getState());
  });

  socket.on("pauseGame", () => {
    tableGame.isPaused = true;
    if (tableGame.botTimeout) clearTimeout(tableGame.botTimeout);
    io.emit("pauseGame");
    io.emit("gameState", tableGame.getState());
  });

  socket.on("resumeGame", () => {
    tableGame.isPaused = false;
    tableGame.checkBotTurn();
    io.emit("resumeGame");
    io.emit("gameState", tableGame.getState());
  });

  socket.on("updateSettings", (config) => {
    tableGame.updateSettings(config);
    io.emit("gameState", tableGame.getState());
  });
});

const PORT = process.env.PORT || 3000;
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  server.listen(PORT, () => {
    console.log(`Paper Poker server running at http://localhost:${PORT}`);
  });
}
