// Persists lifetime ranked stats to a user's row - mirrors the exact formulas
// TableGame already uses for its own in-memory session stats (totalWinnings
// only counts hands actually won, netProfit is winnings minus invested, etc.)
// so a player's profile numbers agree with what the session Stats panel
// would have shown them in the moment.
function applyRankedHandStats(db, userId, delta) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) return null;

  const contributed = delta.contributed || 0;
  const payout = delta.payout || 0;
  const netThisHand = payout - contributed;
  const winningsThisHand = payout > 0 ? payout : 0;

  const newTotalWinnings = row.total_winnings + winningsThisHand;
  const newTotalInvested = row.total_invested + contributed;
  const newNetProfit = newTotalWinnings - newTotalInvested;
  const newBiggestPot = Math.max(row.biggest_pot, delta.potSize || 0);
  const newBiggestWin = Math.max(row.biggest_win, netThisHand);
  const newBiggestLoss = Math.min(row.biggest_loss, netThisHand);

  db.prepare(`
    UPDATE users SET
      hands_played = hands_played + 1,
      hands_won = hands_won + ?,
      total_winnings = ?,
      total_invested = ?,
      net_profit = ?,
      biggest_pot = ?,
      biggest_win = ?,
      biggest_loss = ?,
      showdowns_seen = showdowns_seen + ?,
      showdowns_won = showdowns_won + ?,
      ranked_seconds_played = ranked_seconds_played + ?
    WHERE id = ?
  `).run(
    delta.won ? 1 : 0,
    newTotalWinnings,
    newTotalInvested,
    newNetProfit,
    newBiggestPot,
    newBiggestWin,
    newBiggestLoss,
    delta.showdown ? 1 : 0,
    delta.showdown && delta.showdownWon ? 1 : 0,
    Math.max(0, Math.round(delta.elapsedSeconds || 0)),
    userId
  );

  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

export { applyRankedHandStats };
