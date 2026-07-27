// Ranked play uses one fixed, immutable table configuration regardless of who's
// playing or what difficulty they picked - the whole point is that everyone's
// climbing the same ladder under the same conditions. The server applies this
// unconditionally whenever a game is started as ranked; nothing here is ever
// read from client input.
const RANKED_FIXED_SETTINGS = {
  numPlayers: 6,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  shotClockSeconds: 15,
  turboMode: false,
  resetBalanceEachHand: false,
};

// Presented to the player as buttons, not free-form entry - "hands" is what
// the server actually trusts; "key" only exists for the client to reference
// which one is currently selected.
const TOURNAMENT_LENGTH_PRESETS = [
  { key: "single", label: "Single Hand", hands: 0 },
  { key: "short", label: "Short (10 hands)", hands: 10 },
  { key: "standard", label: "Standard (25 hands)", hands: 25 },
  { key: "long", label: "Long (50 hands)", hands: 50 },
];

function tournamentLengthForKey(key) {
  const preset = TOURNAMENT_LENGTH_PRESETS.find((p) => p.key === key);
  return preset ? preset.hands : 0;
}

export { RANKED_FIXED_SETTINGS, TOURNAMENT_LENGTH_PRESETS, tournamentLengthForKey };
