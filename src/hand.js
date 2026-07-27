import { Deck } from "./deck.js";
import { BettingRound } from "./bettingRound.js";
import { computePots } from "./pots.js";
import { resolveShowdown } from "./showdown.js";
import { compareScores } from "./handEvaluator.js";

const STREETS = ["preflop", "flop", "turn", "river"];

// Orchestrates one complete poker hand: posts blinds, deals hole cards,
// runs betting through preflop/flop/turn/river (dealing community cards
// between streets with burn cards), and resolves payouts at showdown.
export class Hand {
  constructor({ players, minRaise, smallBlind, bigBlind, dealerIndex = 0, deck }) {
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
    this.burnCards = [];
    this.streetIndex = 0;
    this.currentRound = null;
    this.complete = false;
    this.result = null;
    // Set once, the first time every player still live in the hand is all-in
    // (no more decisions possible) - captures the exact board/hole-card state
    // at that moment so callers can compute true all-in win probability.
    this.allInSnapshot = null;

    this._dealHoleCards();
    this._postBlinds();
    this._startStreet();
  }

  _dealHoleCards() {
    for (const id of this.order) this.holeCards.set(id, this.deck.draw(2));
  }

  // Used for pot/showdown eligibility, where an all-in player still counts
  // as "in the hand" even though they have no more decisions to make.
  _activePlayers() {
    return this.order.filter((id) => !this.folded.has(id));
  }

  // Used for picking who acts next. Unlike _activePlayers(), this also skips
  // anyone already all-in (stack 0) - they're still in the hand for pot
  // purposes, but have no legal action to take, so handing them "the turn"
  // on a later street would stall the hand forever (nothing else advances
  // it - a human sees a turn with no legal actions, and a bot's own
  // legalActions() would come back all-false too).
  _firstToActFrom(seatIndex) {
    const n = this.order.length;
    for (let step = 0; step < n; step++) {
      const id = this.order[(seatIndex + step) % n];
      if (this.folded.has(id)) continue;
      if (this.stacks.get(id) === 0) continue;
      return id;
    }
    return null; // everyone left in the hand is all-in - no one can act
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

    this.sbId = this.order[sbSeat];
    this.bbId = this.order[bbSeat];

    this._postBlind(this.sbId, this.smallBlind);
    this._postBlind(this.bbId, this.bigBlind);

    this._preflopFirstActSeat = n === 2 ? sbSeat : (bbSeat + 1) % n;
    // Heads-up is the one case where preflop and postflop first-to-act
    // differ: the button/SB acts first preflop, but the big blind acts
    // first on every street after that (the button gets the positional
    // advantage of acting last once the flop comes down) - everywhere else,
    // first-to-act postflop is simply the small blind seat.
    this._postflopFirstActSeat = n === 2 ? bbSeat : sbSeat;
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

  _burn() {
    const [burned] = this.deck.draw(1);
    this.burnCards.push(burned);
  }

  _startStreet() {
    const streetName = this.currentStreetName();

    // Burn before dealing community cards
    if (streetName === "flop") {
      this._burn();
      this.board.push(...this.deck.draw(3));
    } else if (streetName === "turn" || streetName === "river") {
      this._burn();
      this.board.push(...this.deck.draw(1));
    }

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
      const firstActId = this._firstToActFrom(this._preflopFirstActSeat);
      // null means everyone left is already all-in - the actingIndex value
      // doesn't matter in that case, since isComplete() will end the street
      // immediately below regardless of who it points to.
      actingIndex = firstActId != null ? activeIds.indexOf(firstActId) : 0;
    } else {
      const firstActId = this._firstToActFrom(this._postflopFirstActSeat);
      actingIndex = firstActId != null ? activeIds.indexOf(firstActId) : 0;
    }

    this.currentRound = new BettingRound({
      players: roundPlayers,
      actingIndex,
      minRaise: this.minRaise,
      currentBet,
      numPlayersAtStart: this._activePlayers().length,
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

    // If everyone still live in the hand is now all-in, no further decisions
    // are possible - the remaining runout is pure chance. Snapshot the board
    // and hole cards right now, before any more community cards are dealt.
    if (!this.allInSnapshot) {
      const active = this._activePlayers();
      const everyoneAllIn = active.every((id) => this.stacks.get(id) === 0);
      if (everyoneAllIn) {
        this.allInSnapshot = {
          boardAtAllIn: [...this.board],
          participants: active.map((id) => ({ id, holeCards: this.holeCards.get(id) })),
        };
      }
    }

    this.streetIndex += 1;
    this._startStreet();
  }

  _bestAmong(playerIds, showdownResults) {
    const relevant = showdownResults.filter((r) => playerIds.includes(r.id));
    if (relevant.length === 0) return [];
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

    // Deal remaining board if hand ended early (e.g. all-ins preflop)
    while (this.board.length < 5) {
      this._burn();
      const need = 5 - this.board.length;
      this.board.push(...this.deck.draw(need === 2 ? 3 : need));
    }

    const showdownPlayers = activeIds.map((id) => ({ id, holeCards: this.holeCards.get(id) }));
    const showdown = resolveShowdown(showdownPlayers, this.board);

    for (const pot of pots) {
      const potWinners = this._bestAmong(pot.eligiblePlayerIds, showdown.results);
      if (potWinners.length === 0) continue;
      const share = Math.floor(pot.amount / potWinners.length);
      let remainder = pot.amount - share * potWinners.length;

      // Award odd chips to the winner closest to the left of the dealer button
      const sortedWinners = [...potWinners].sort((a, b) => {
        const aIdx = this.order.indexOf(a);
        const bIdx = this.order.indexOf(b);
        const dealerIdx = this.dealerIndex;
        const aDist = (aIdx - dealerIdx + this.order.length) % this.order.length;
        const bDist = (bIdx - dealerIdx + this.order.length) % this.order.length;
        return aDist - bDist;
      });

      for (const id of sortedWinners) {
        const extra = remainder > 0 ? 1 : 0;
        payouts.set(id, payouts.get(id) + share + extra);
        if (remainder > 0) remainder -= 1;
      }
    }

    this.result = { pots, payouts, showdown };
  }
}