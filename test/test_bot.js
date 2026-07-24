import { Hand } from "../src/hand.js";
import { getEasyAction } from "../src/bots/easyBot.js";
import { cardToString } from "../src/deck.js";

async function simulateGame() {
  const players = [
    { id: "Human", stack: 1000 },
    { id: "EasyBot_1", stack: 1000 },
    { id: "EasyBot_2", stack: 1000 },
  ];

  const hand = new Hand({
    players,
    minRaise: 20,
    smallBlind: 10,
    bigBlind: 20,
    dealerIndex: 0,
  });

  console.log("Game Start! Human vs 2 EasyBots.");

  while (!hand.complete) {
    const actingId = hand.actingPlayerId();
    
    if (actingId === "Human") {
      // For this test, we'll just make the human "auto-call/check" 
      // or you can imagine this is where the UI input goes.
      const legal = hand.legalActions("Human");
      const action = legal.check ? "check" : "call";
      console.log(`> Human automatically ${action}s`);
      hand.applyAction("Human", action);
    } else {
      // Bot turn
      const decision = getEasyAction(actingId, hand);
      console.log(`> ${actingId} decides to: ${decision.action} ${decision.amount || ""}`);
      
      // Add a small "thinking" delay
      await new Promise(r => setTimeout(r, 1000));
      
      hand.applyAction(actingId, decision.action, decision.amount);
    }

    if (hand.board.length > 0) {
        console.log("Board: " + hand.board.map(cardToString).join(" "));
    }
  }

  console.log("\n--- Hand Results ---");
  for (const [id, amt] of hand.result.payouts) {
    if (amt > 0) console.log(`${id} won ${amt}`);
  }
}

simulateGame();
