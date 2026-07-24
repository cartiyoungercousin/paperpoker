// Manages the betting for a single street (preflop, flop, turn, or river).
// One BettingRound instance = one street. The caller is responsible for
// creating a new BettingRound for the next street (carrying stacks
// forward) and for running showdown/pot payout once the hand ends.
//
// KNOWN SIMPLIFICATION: real poker distinguishes a full raise (which
// reopens the action for everyone) from an all-in raise for less than a
// full raise (which does NOT reopen action for players who already acted
// at the current bet level). This engine treats every raise as fully
// reopening the action. That's wrong in a small edge case (short all-in
// raises) but fine for an MVP - worth revisiting before calling betting
// "rules-complete."
export class BettingRound {
  constructor({ players, actingIndex = 0, minRaise, currentBet = 0, numPlayersAtStart = players.length }) {
    // players: [{ id, stack, contributed }] - contributed is optional and
    // lets a caller pre-post forced bets (blinds) before betting starts;
    // it defaults to 0, so existing callers are unaffected.
    this.players = players.map((p) => ({
      id: p.id,
      stack: p.stack,
      contributed: p.contributed || 0, // chips put in during THIS street
      folded: false,
      allIn: p.stack === 0, // covers a blind that used a player's whole stack
    }));
    this.currentBet = currentBet;
    this.minRaise = minRaise;
    this.actingIndex = actingIndex;
    this.actedSinceLastAggression = new Set();
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  activePlayers() {
    return this.players.filter((p) => !p.folded);
  }

  playersWhoCanAct() {
    return this.players.filter((p) => !p.folded && !p.allIn);
  }

  actingPlayer() {
    return this.players[this.actingIndex];
  }

  legalActions(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || player.folded || player.allIn) {
      return {
        fold: false,
        check: false,
        call: false,
        callAmount: 0,
        bet: false,
        raise: false,
        minRaiseTo: null,
        maxRaiseTo: null,
      };
    }

    const toCall = this.currentBet - player.contributed;
    const canCheck = toCall === 0;
    const callAmount = Math.min(Math.max(toCall, 0), player.stack);

    const canBet = this.currentBet === 0 && player.stack > 0;
    const canRaise = this.currentBet > 0 && player.stack > toCall;

    const maxRaiseTo = player.contributed + player.stack; // all-in
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);

    return {
      fold: true,
      check: canCheck,
      call: toCall > 0,
      callAmount,
      bet: canBet,
      raise: canRaise,
      minRaiseTo: canBet || canRaise ? minRaiseTo : null,
      maxRaiseTo: canBet || canRaise ? maxRaiseTo : null,
    };
  }

  // action: "fold" | "check" | "call" | "bet" | "raise"
  // amount: for "bet"/"raise" only - the TOTAL amount this player will
  // have contributed this street after the action (i.e. "raise to X",
  // not "raise by X").
  applyAction(playerId, action, amount) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    if (this.actingPlayer().id !== playerId) {
      throw new Error(`It is not ${playerId}'s turn to act`);
    }

    const legal = this.legalActions(playerId);

    if (action === "fold") {
      player.folded = true;
    } else if (action === "check") {
      if (!legal.check) throw new Error(`${playerId} cannot check - there is a bet to call`);
      this.actedSinceLastAggression.add(playerId);
    } else if (action === "call") {
      if (!legal.call) throw new Error(`${playerId} has nothing to call`);
      player.stack -= legal.callAmount;
      player.contributed += legal.callAmount;
      if (player.stack === 0) player.allIn = true;
      this.actedSinceLastAggression.add(playerId);
    } else if (action === "bet" || action === "raise") {
      if (action === "bet" && !legal.bet) throw new Error(`${playerId} cannot bet here - use raise`);
      if (action === "raise" && !legal.raise) throw new Error(`${playerId} cannot raise here`);
      if (amount == null) throw new Error(`${action} requires an amount (the total you're raising TO)`);

      const raiseTo = amount;
      if (raiseTo > legal.maxRaiseTo) {
        throw new Error(`${playerId} doesn't have enough chips to make it ${raiseTo}`);
      }
      if (raiseTo < legal.minRaiseTo && raiseTo < legal.maxRaiseTo) {
        throw new Error(`${playerId}'s raise to ${raiseTo} is below the minimum of ${legal.minRaiseTo}`);
      }

      const additional = raiseTo - player.contributed;
      player.stack -= additional;
      player.contributed = raiseTo;
      if (player.stack === 0) player.allIn = true;

      this.currentBet = raiseTo;
      this.actedSinceLastAggression = new Set([playerId]);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    this._advanceActingIndex();
  }

  _advanceActingIndex() {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.actingIndex + step) % n;
      const p = this.players[idx];
      if (!p.folded && !p.allIn) {
        this.actingIndex = idx;
        return;
      }
    }
    // no one left who can act - isComplete() will be true
  }

  isComplete() {
    if (this.activePlayers().length <= 1) return true; // everyone else folded

    const canAct = this.playersWhoCanAct();
    if (canAct.length === 0) return true; // everyone left is all-in

    const allMatched = canAct.every((p) => p.contributed === this.currentBet);
    const allActed = canAct.every((p) => this.actedSinceLastAggression.has(p.id));
    return allMatched && allActed;
  }

  // Contribution snapshot to feed into computePots() once the hand ends.
  contributions() {
    return this.players.map((p) => ({
      id: p.id,
      contributed: p.contributed,
      folded: p.folded,
    }));
  }
}
