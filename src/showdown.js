import { bestOf7, compareScores } from "./handEvaluator.js";

// players: [{ id, holeCards: [card, card] }, ...]
// board: [card, card, card, card, card]
// Returns { results: [{ id, score, bestCards }], winnerIds: [id, ...] }
// winnerIds has more than one entry when there's a tie (split pot).
export function resolveShowdown(players, board) {
  if (board.length !== 5) {
    throw new Error("resolveShowdown requires a full 5-card board");
  }

  const results = players.map((p) => {
    const sevenCards = [...p.holeCards, ...board];
    const best = bestOf7(sevenCards);
    return { id: p.id, score: best.score, bestCards: best.cards };
  });

  let winnerIds = [results[0].id];
  let bestScore = results[0].score;
  for (const r of results.slice(1)) {
    const cmp = compareScores(r.score, bestScore);
    if (cmp > 0) {
      bestScore = r.score;
      winnerIds = [r.id];
    } else if (cmp === 0) {
      winnerIds.push(r.id);
    }
  }

  return { results, winnerIds };
}
