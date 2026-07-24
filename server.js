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

    // Stats tracking
    this.stats = {
      handsPlayed: 0,
      handsWon: 0,
      totalWinnings: 0,
      biggestPot: 0,
      totalActions: 0,
      vpipActions: 0,
      totalBets: 0,
      totalRaises: 0,
      totalCalls: 0,
      totalFolds: 0,
      totalChecks: 0,
      totalPotWon: 0,
      totalInvested: 0,
    };

    // Track last action for each player for display
    this.lastActions = {};

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

  getState() {
    if (!this.hand) {
      return {
        gameStarted: this.gameStarted,
        handCount: this.handCount,
        stats: this.stats,
        resetBalanceEachHand: this.resetBalanceEachHand,
        players: this.players.map(p => ({
          id: p.id, type: p.type, seat: p.seat, stack: p.stack, colorClass: p.colorClass,
          contributed: 0, folded: false, holeCards: [], active: false,
        })),
        street: "", board: [], pot: 0, actingId: null,
        legalActions: null, complete: false, results: null,
        handHistory: this.handHistory,
        smallBlind: this.smallBlind, bigBlind: this.bigBlind,
        isPaused: !!this.isPaused,
        yourHandDescription: "",
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

    let pot = 0;
    for (const v of this.hand.totalContributed.values()) pot += v;
    if (this.hand.currentRound) {
      for (const p of this.hand.currentRound.players) pot += p.contributed;
    }

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
      stats: this.stats, resetBalanceEachHand: this.resetBalanceEachHand,
      lastActions: this.lastActions,
      balanceHistory: this.balanceHistory,
      isPaused: !!this.isPaused,
      yourHandDescription,
    };
  }

  startNewHand() {
    if (this.botTimeout) clearTimeout(this.botTimeout);

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
    this.dealingNewHand = false;
    this.lastActions = {};
    this.checkBotTurn();
  }

  applyPlayerAction(playerId, action, amount) {
    if (!this.hand || this.hand.complete || this.isPaused) return false;
    if (this.hand.actingPlayerId() !== playerId) return false;

    const prevStreet = this.hand.currentStreetName();
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

      this.stats.totalActions++;
      if (action === "call") { this.stats.vpipActions++; this.stats.totalCalls++; }
      else if (action === "bet") { this.stats.vpipActions++; this.stats.totalBets++; }
      else if (action === "raise") { this.stats.vpipActions++; this.stats.totalRaises++; }
      else if (action === "fold") this.stats.totalFolds++;
      else if (action === "check") this.stats.totalChecks++;

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
  }

  // Track balance after every hand completes (called in handleHandComplete)

  checkBotTurn() {
    if (!this.hand || this.hand.complete || this.isPaused) return;
    const actingId = this.hand.actingPlayerId();
    const actingPlayer = this.players.find(p => p.id === actingId);
    if (!actingPlayer || actingPlayer.type !== "bot") return;

    // Emit botTurn event so client can play a sound
    io.emit("botTurn", { playerId: actingId });

    // Delay between 1-2 seconds for smooth bot play
    const delay = 1000 + Math.floor(Math.random() * 1000);

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

      try {
        this.hand.applyAction(actingId, decision.action, decision.amount);
        const amtStr = decision.amount ? ` ${decision.amount}` : "";
        this.handHistory.push(`${actingId}: ${decision.action}${amtStr}`);
        this.lastActions[actingId] = { action: decision.action, amount: decision.amount || 0, street: this.hand.currentStreetName() };
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
          }
        }
      }
    }
    if (youWon) this.stats.handsWon++;

    if (this.hand.result.pots) {
      const totalPot = this.hand.result.pots.reduce((s, pot) => s + pot.amount, 0);
      if (totalPot > this.stats.biggestPot) this.stats.biggestPot = totalPot;
    }

    // Track total invested
    const you = this.players.find(p => p.id === "You");
    if (you) {
      const invested = this.startingStack - you.stack;
      if (invested > 0) this.stats.totalInvested += invested;
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
      totalActions: 0, vpipActions: 0, totalBets: 0, totalRaises: 0,
      totalCalls: 0, totalFolds: 0, totalChecks: 0, totalPotWon: 0, totalInvested: 0,
    };
    this.dealerIndex = 0;
  }
}

export { TableGame };

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
    if (tableGame.hand && tableGame.hand.complete) {
      const hand = tableGame.hand;
      const analysis = {
        handCount: tableGame.handCount,
        board: hand.board,
        holeCards: hand.holeCards.get("You") || [],
        totalContributed: Object.fromEntries(hand.totalContributed),
        result: hand.result,
        order: hand.order,
        pots: hand.result ? hand.result.pots : [],
        stacks: Object.fromEntries(hand.stacks),
        payouts: hand.result ? Object.fromEntries(hand.result.payouts) : {},
      };
      socket.emit("handAnalysis", analysis);
    }
  });

  socket.on("startGame", () => {
    tableGame.gameStarted = true;
    tableGame.startNewHand();
    io.emit("gameState", tableGame.getState());
  });

  socket.on("setResetBalance", ({ reset }) => {
    tableGame.resetBalanceEachHand = reset;
  });

  socket.on("pauseGame", () => {
    tableGame.isPaused = true;
    if (tableGame.botTimeout) clearTimeout(tableGame.botTimeout);
    io.emit("gameState", tableGame.getState());
  });

  socket.on("resumeGame", () => {
    tableGame.isPaused = false;
    tableGame.checkBotTurn();
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
