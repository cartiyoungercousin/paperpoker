import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Hand } from "./src/hand.js";
import { cardToString } from "./src/deck.js";

const rl = readline.createInterface({ input, output });

function currentPotTotal(hand) {
  let total = 0;
  for (const v of hand.totalContributed.values()) total += v;
  if (hand.currentRound) {
    for (const p of hand.currentRound.players) total += p.contributed;
  }
  return total;
}

function printState(hand) {
  console.log("\n--- " + hand.currentStreetName().toUpperCase() + " ---");
  if (hand.board.length > 0) {
    console.log("Board: " + hand.board.map(cardToString).join(" "));
  }
  console.log("Pot: " + currentPotTotal(hand));
}

async function playHand() {
  const hand = new Hand({
    players: [
      { id: "player1", stack: 100 },
      { id: "player2", stack: 100 },
    ],
    minRaise: 2,
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 0,
  });

  console.log("New hand. player1 is dealer/small blind, player2 is big blind.");
  console.log("Type: fold | check | call | bet <amount> | raise <amount>");
  console.log("(bet/raise amount is the TOTAL you're making it, not an increment)");

  while (!hand.complete) {
    printState(hand);
    const actingId = hand.actingPlayerId();
    const hole = hand.holeCards.get(actingId).map(cardToString).join(" ");
    console.log(`${actingId}'s turn. Hole cards: ${hole}`);

    const legal = hand.legalActions(actingId);
    const options = [];
    if (legal.fold) options.push("fold");
    if (legal.check) options.push("check");
    if (legal.call) options.push(`call (${legal.callAmount})`);
    if (legal.bet) options.push(`bet <amt> (min ${legal.minRaiseTo}, max ${legal.maxRaiseTo})`);
    if (legal.raise) options.push(`raise <amt> (min ${legal.minRaiseTo}, max ${legal.maxRaiseTo})`);
    console.log("Options: " + options.join(" | "));

    const answer = (await rl.question("> ")).trim().toLowerCase();
    const [action, amountStr] = answer.split(/\s+/);
    const amount = amountStr ? Number(amountStr) : undefined;

    try {
      hand.applyAction(actingId, action, amount);
    } catch (err) {
      console.log("Invalid action: " + err.message);
    }
  }

  console.log("\n=== HAND COMPLETE ===");
  console.log("Board: " + hand.board.map(cardToString).join(" "));
  for (const id of hand.order) {
    console.log(`${id} hole cards: ${hand.holeCards.get(id).map(cardToString).join(" ")}`);
  }
  console.log("Payouts:");
  for (const [id, amt] of hand.result.payouts) {
    console.log(`  ${id}: +${amt}`);
  }

  rl.close();
}

playHand();