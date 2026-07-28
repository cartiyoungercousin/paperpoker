// Rumble uses one fixed, immutable table configuration, the same discipline
// ranked already uses (src/rankedConfig.js) and for the same reason - a
// power-up session should mean the same stakes/pace for everyone, not
// whatever the client's last Game Config happened to be set to. The server
// applies this unconditionally whenever a game is started as Rumble; nothing
// here is ever read from client input.
const RUMBLE_FIXED_SETTINGS = {
  numPlayers: 6,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  shotClockSeconds: 30,
  turboMode: false,
  resetBalanceEachHand: false,
};

// Always exactly 5 hands - not a client-configurable tournament length like
// ranked's TOURNAMENT_LENGTH_PRESETS, just a fixed session size. Whoever has
// the most chips once hand 5 completes wins.
const RUMBLE_HANDS_TOTAL = 5;

// Rumble's outcome is chaotic (power-ups deliberately inject luck on top of
// skill), so unlike the difficulty-scaled DIFFICULTY_COIN_REWARD table
// (src/coins.js) it pays one flat amount for winning the session and
// nothing at all for losing it - no penalty, since the result isn't purely
// a reflection of play quality.
const RUMBLE_WIN_COINS_REWARD = 2;

export { RUMBLE_FIXED_SETTINGS, RUMBLE_HANDS_TOTAL, RUMBLE_WIN_COINS_REWARD };
