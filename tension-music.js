// ===== Adaptive Tension Music - trigger threshold logic =====
// Pure, DOM-free decision math pulled into its own file so it's testable
// under Node without a real Audio/browser environment - same pattern
// bot-mascots.js and range-trainer.js already use. The actual audio-graph
// crossfade (gain ramping, the tension <audio> element itself) stays in
// index.html's inline script, since that part genuinely needs the DOM/Web
// Audio APIs and can't be meaningfully unit tested anyway.

(function () {
  const POT_FRACTION_THRESHOLD = 0.5;

  // Decides whether the suspenseful crossfade should be active right now,
  // computed entirely from the gameState payload the client already
  // receives - no server changes needed. True once the pot has grown to
  // roughly half (or more) of every chip still in play, or the instant any
  // live player is all-in, whichever comes first. False once the hand is
  // over or there's no hand in progress at all.
  function computeTensionActive(state) {
    if (!state || state.complete || !state.street) return false;
    const players = state.players || [];
    if (players.length === 0) return false;
    const pot = state.pot || 0;
    const totalStacks = players.reduce((sum, p) => sum + (p.stack || 0), 0);
    const totalChips = pot + totalStacks;
    const potFraction = totalChips > 0 ? pot / totalChips : 0;
    const anyAllIn = players.some((p) => !p.folded && p.stack === 0);
    return potFraction >= POT_FRACTION_THRESHOLD || anyAllIn;
  }

  const TensionMusic = { computeTensionActive, POT_FRACTION_THRESHOLD };
  if (typeof window !== 'undefined') window.TensionMusic = TensionMusic;
  if (typeof module !== 'undefined' && module.exports) module.exports = TensionMusic;
})();
