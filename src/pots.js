// Computes the main pot and any side pots given each player's total chip
// contribution for the hand so far, and whether they've folded.
//
// This is the standard algorithm: sort the distinct contribution amounts,
// and for each "layer" between one amount and the next, everyone who put
// in at least that much shares the cost of that layer, and everyone who
// put in at least that much AND hasn't folded is eligible to win it.
//
// contributions: [{ id, contributed, folded }]
// Returns: [{ amount, eligiblePlayerIds }], main pot first, then side pots
// in the order they were created.
export function computePots(contributions) {
  const active = contributions.filter((p) => p.contributed > 0);
  if (active.length === 0) return [];

  const levels = [...new Set(active.map((p) => p.contributed))].sort((a, b) => a - b);

  const pots = [];
  let prevLevel = 0;

  for (const level of levels) {
    const increment = level - prevLevel;
    prevLevel = level;
    if (increment <= 0) continue;

    const payers = active.filter((p) => p.contributed >= level);
    const amount = increment * payers.length;
    const eligiblePlayerIds = payers.filter((p) => !p.folded).map((p) => p.id);

    if (eligiblePlayerIds.length > 0) {
      pots.push({ amount, eligiblePlayerIds });
    } else if (pots.length > 0) {
      // Everyone who could contest this layer has folded - fold this
      // leftover money into the pot below it rather than creating an
      // unwinnable pot.
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount, eligiblePlayerIds: [] });
    }
  }

  return pots;
}
