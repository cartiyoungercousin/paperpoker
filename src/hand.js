import { Deck } from "./deck.js";
import { BettingRound } from "./bettingRound.js";
import { computePots } from "./pots.js";
import { resolveShowdown } from "./showdown.js";
import { compareScores } from "./handEvaluator.js";

const STREETS = ["preflop", "flop", "turn", "river"];

// Orchestrates one complete poker hand: posts blinds, deals hole cards,
// runs betting through preflop/flop/turn/river (dealing community cards
// between streets), and resolves payouts at showdown - or immediately if
// everyone but one player folds.
//
// KNOWN SIMPLIFICATION: heads-up (2-player) postflop action order uses
// the same general rule as 3+ players (small blind acts first), rather
// than the special heads-up rule where the big blind acts first
// postflop. Preflop heads-up order is correct (small blind/dealer acts
// first). Worth a dedicated fix before relying on this for heads-up play
// specifically - fine for 3+ handed tables as-is.
export class Hand {
  constructor({ players, minRaise, smallBlind, bigBlind, dealerIndex = 0, deck }) {
    // players: [{ id, stack }] in seat order (seat 0, 1, 2... clockwise)
    this.order = players.map((p) => p.id);
    this.stacks = new Map(players.map((p) => [p.id, p.stack]));
    this.minRaise = minRaise;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.dealerIndex = dealerIndex;
    this.deck = deck || new Deck().shuffle();

    this.folded = new Set();
    this.totalContributed = new Map(players.map((p) => [p.id, 0]));
    this.holeCards = new Map();
    this.board = [];
    this.streetIndex = 0;
    this.currentRound = null;
    this.complete = false;
    this.result = null;

    this._dealHoleCards();
    this._postBlinds();
    this._startStreet();
  }

  _dealHoleCards() {
    for (const id of this.order) this.holeCards.set(id, this.deck.draw(2));
  }

  _firstActiveIdFrom(seatIndex) {
    const n = this.order.length;
    for (let step = 0; step < n; step++) {
      const id = this.order[(seatIndex + step) % n];
      if (!this.folded.has(id)) return id;
    }
    return null;
  }

  _postBlind(id, amount) {
    const stack = this.stacks.get(id);
    const posted = Math.min(amount, stack);
    this.stacks.set(id, stack - posted);
    this._blindContribution.set(id, (this._blindContribution.get(id) || 0) + posted);
  }

  _postBlinds() {
    const n = this.order.length;
    this._blindContribution = new Map();

    const sbSeat = n === 2 ? this.dealerIndex : (this.dealerIndex + 1) % n;
    const bbSeat = n === 2 ? (this.dealerIndex + 1) % n : (this.dealerIndex + 2) % n;

    this._postBlind(this.order[sbSeat], this.smallBlind);
    this._postBlind(this.order[bbSeat], this.bigBlind);

    this._preflopFirstActSeat = n === 2 ? sbSeat : (bbSeat + 1) % n;
    this._postflopFirstActSeat = sbSeat;
  }

  _activePlayers() {
    return this.order.filter((id) => !this.folded.has(id));
  }

  currentStreetName() {
    return STREETS[this.streetIndex];
  }

  actingPlayerId() {
    if (this.complete || !this.currentRound) return null;
    return this.currentRound.actingPlayer().id;
  }

  legalActions(playerId) {
    if (this.complete || !this.currentRound) return null;
    return this.currentRound.legalActions(playerId);
  }

  _startStreet() {
    const streetName = this.currentStreetName();
    if (streetName === "flop") this.board.push(...this.deck.draw(3));
    else if (streetName === "turn" || streetName === "river") this.board.push(...this.deck.draw(1));

    const activeIds = this._activePlayers();
    if (activeIds.length <= 1) {
      this._finish();
      return;
    }

    const roundPlayers = activeIds.map((id) => ({
      id,
      stack: this.stacks.get(id),
      contributed: streetName === "preflop" ? this._blindContribution.get(id) || 0 : 0,
    }));

    let actingIndex;
    let currentBet = 0;
    if (streetName === "preflop") {
      currentBet = this.bigBlind;
      const firstActId = this._firstActiveIdFrom(this._preflopFirstActSeat);
      actingIndex = activeIds.indexOf(firstActId);
    } else {
      const firstActId = this._firstActiveIdFrom(this._postflopFirstActSeat);
      actingIndex = activeIds.indexOf(firstActId);
    }

    this.currentRound = new BettingRound({
      players: roundPlayers,
      actingIndex,
      minRaise: this.minRaise,
      currentBet,
    });

    if (this.currentRound.isComplete()) this._closeStreet();
  }

  applyAction(playerId, action, amount) {
    if (this.complete) throw new Error("Hand is already complete");
    this.currentRound.applyAction(playerId, action, amount);
    if (this.currentRound.isComplete()) this._closeStreet();
  }

  _closeStreet() {
    for (const p of this.currentRound.players) {
      this.stacks.set(p.id, p.stack);
      this.totalContributed.set(p.id, this.totalContributed.get(p.id) + p.contributed);
      if (p.folded) this.folded.add(p.id);
    }

    if (this._activePlayers().length <= 1) {
      this._finish();
      return;
    }
    if (this.streetIndex >= STREETS.length - 1) {
      this._finish();
      return;
    }

    this.streetIndex += 1;
    this._startStreet();
  }

  _bestAmong(playerIds, showdownResults) {
    const relevant = showdownResults.filter((r) => playerIds.includes(r.id));
    let bestIds = [relevant[0].id];
    let bestScore = relevant[0].score;
    for (const r of relevant.slice(1)) {
      const cmp = compareScores(r.score, bestScore);
      if (cmp > 0) {
        bestScore = r.score;
        bestIds = [r.id];
      } else if (cmp === 0) {
        bestIds.push(r.id);
      }
    }
    return bestIds;
  }

  _finish() {
    this.complete = true;
    this.currentRound = null;

    const contributions = this.order.map((id) => ({
      id,
      contributed: this.totalContributed.get(id),
      folded: this.folded.has(id),
    }));
    const pots = computePots(contributions);
    const payouts = new Map(this.order.map((id) => [id, 0]));
    const activeIds = this._activePlayers();

    if (activeIds.length === 1) {
      const winnerId = activeIds[0];
      for (const pot of pots) payouts.set(winnerId, payouts.get(winnerId) + pot.amount);
      this.result = { pots, payouts, showdown: null };
      return;
    }

    // If betting finished early (e.g. everyone went all-in preflop), deal
    // out whatever's left of the board before resolving showdown.
    while (this.board.length < 5) {
      const need = 5 - this.board.length;
      this.board.push(...this.deck.draw(need === 2 ? 3 : need));
    }

    const showdownPlayers = activeIds.map((id) => ({ id, holeCards: this.holeCards.get(id) }));
    const showdown = resolveShowdown(showdownPlayers, this.board);

    for (const pot of pots) {
      const potWinners = this._bestAmong(pot.eligiblePlayerIds, showdown.results);
      const share = Math.floor(pot.amount / potWinners.length);
      let remainder = pot.amount - share * potWinners.length;
      for (const id of potWinners) {
        payouts.set(id, payouts.get(id) + share + (remainder > 0 ? 1 : 0));
        if (remainder > 0) remainder -= 1;
      }
    }

    this.result = { pots, payouts, showdown };
  }
}