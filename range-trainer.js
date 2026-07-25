// ===== Preflop Range Trainer =====
// A standalone quiz mode, fully self-contained client-side (no server/socket
// involvement at all). Loaded after the main inline script in index.html so
// it can reuse cHTML() for card rendering instead of redefining it.
//
// Reference ranges are generated (not hand-authored) from the Chen Formula -
// a well-known, simple point system for ranking the 169 canonical starting
// hands (https://en.wikipedia.org/wiki/Chen_formula) - then bucketed into
// raise/call/fold by percentile per a simplified 4-way position split
// (Early/Middle/Late/Blinds) and three scenarios (unopened, facing one raise,
// facing a 3-bet). This is explicitly a simplified training reference, not
// solver output - no bet-sizing or stack-depth is modeled, and the numbers
// are directionally reasonable rather than precise.

(function () {
  const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const RANK_LETTER = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
  const TRAINER_SUITS = ['h', 'd', 'c', 's'];

  const POSITIONS = ['Early', 'Middle', 'Late', 'Blinds'];
  const SCENARIOS = ['RFI', 'vsOpen', 'vs3Bet'];
  const POSITION_LABEL = {
    Early: 'Early Position',
    Middle: 'Middle Position',
    Late: 'Late Position (CO/BTN)',
    Blinds: 'the Blinds (SB)',
  };

  // % of the 169 hands that fall into each action tier, by position. Loose
  // approximations of realistic 6-max ranges, not solver-exact.
  const RFI_FRACTIONS = { Early: 0.12, Middle: 0.18, Late: 0.32, Blinds: 0.40 };
  const VSOPEN_FRACTIONS = {
    Early: { raise: 0.05, call: 0.10 },
    Middle: { raise: 0.06, call: 0.13 },
    Late: { raise: 0.08, call: 0.18 },
    Blinds: { raise: 0.08, call: 0.25 },
  };
  const VS3BET_FRACTIONS = {
    Early: { raise: 0.03, call: 0.08 },
    Middle: { raise: 0.04, call: 0.09 },
    Late: { raise: 0.05, call: 0.11 },
    Blinds: { raise: 0.05, call: 0.12 },
  };

  function chenHighCardScore(rank) {
    if (rank === 14) return 10;
    if (rank === 13) return 8;
    if (rank === 12) return 7;
    if (rank === 11) return 6;
    if (rank === 10) return 5;
    return rank / 2;
  }

  // The Chen Formula: a quick point score for a starting hand's strength.
  function chenScore(rankHigh, rankLow, suited) {
    let score = chenHighCardScore(rankHigh);
    if (rankHigh === rankLow) {
      score = Math.max(score * 2, 5);
    } else {
      if (suited) score += 2;
      const gap = rankHigh - rankLow - 1;
      if (gap === 1) score -= 1;
      else if (gap === 2) score -= 2;
      else if (gap === 3) score -= 4;
      else if (gap >= 4) score -= 5;
      // Straight-completing bonus for connectors/one-gappers below a Queen
      if (gap <= 1 && rankHigh < 12) score += 1;
    }
    score = Math.ceil(score * 2) / 2; // round up to the nearest 0.5
    return Math.max(score, 0);
  }

  // Builds all 169 canonical starting hands (13 pairs + 78 suited + 78 offsuit).
  function buildHandList() {
    const hands = [];
    for (let i = 0; i < RANKS.length; i++) {
      for (let j = i; j < RANKS.length; j++) {
        const hi = RANKS[i], lo = RANKS[j];
        if (hi === lo) {
          hands.push({ key: RANK_LETTER[hi] + RANK_LETTER[hi], hi, lo, suited: false, pair: true, score: chenScore(hi, lo, false) });
        } else {
          hands.push({ key: RANK_LETTER[hi] + RANK_LETTER[lo] + 's', hi, lo, suited: true, pair: false, score: chenScore(hi, lo, true) });
          hands.push({ key: RANK_LETTER[hi] + RANK_LETTER[lo] + 'o', hi, lo, suited: false, pair: false, score: chenScore(hi, lo, false) });
        }
      }
    }
    return hands;
  }

  function rankedHandList() {
    const hands = buildHandList();
    hands.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.pair !== b.pair) return a.pair ? -1 : 1;
      if (a.suited !== b.suited) return a.suited ? -1 : 1;
      if (a.hi !== b.hi) return b.hi - a.hi;
      return b.lo - a.lo;
    });
    return hands;
  }

  // Splits the ranked hand list into raise/call/fold tiers by percentile,
  // marking the couple of hands nearest each boundary as "borderline" with a
  // specific alternate action that's also graded as correct (mixed-frequency
  // hands in real ranges are rarely a pure 100/0 decision).
  function classifyRange(ranked, raiseFraction, callFraction) {
    const n = ranked.length;
    const raiseCount = Math.round(n * raiseFraction);
    const callCount = Math.round(n * callFraction);
    const table = {};
    ranked.forEach((h, idx) => {
      let action, altAction = null;
      if (idx < raiseCount) {
        action = 'raise';
        if (callCount > 0 && idx >= raiseCount - 2) altAction = 'call';
      } else if (idx < raiseCount + callCount) {
        action = 'call';
        if (idx < raiseCount + 2) altAction = 'raise';
        else if (idx >= raiseCount + callCount - 2) altAction = 'fold';
      } else {
        action = 'fold';
        if (callCount > 0 && idx < raiseCount + callCount + 2) altAction = 'call';
      }
      table[h.key] = { action, altAction };
    });
    return table;
  }

  function buildRangeData() {
    const ranked = rankedHandList();
    const data = { RFI: {}, vsOpen: {}, vs3Bet: {} };
    for (const pos of POSITIONS) data.RFI[pos] = classifyRange(ranked, RFI_FRACTIONS[pos], 0);
    for (const pos of POSITIONS) data.vsOpen[pos] = classifyRange(ranked, VSOPEN_FRACTIONS[pos].raise, VSOPEN_FRACTIONS[pos].call);
    for (const pos of POSITIONS) data.vs3Bet[pos] = classifyRange(ranked, VS3BET_FRACTIONS[pos].raise, VS3BET_FRACTIONS[pos].call);
    return data;
  }

  const RANGE_DATA = buildRangeData();

  function scenarioText(scenario, position) {
    if (scenario === 'RFI') return `Everyone has folded to you in ${POSITION_LABEL[position]}. What do you do?`;
    if (scenario === 'vsOpen') return `A player raises before it's your turn to act. You are in ${POSITION_LABEL[position]}. What do you do?`;
    return `You raised, and now someone re-raises (3-bets) you. You are in ${POSITION_LABEL[position]}. What do you do?`;
  }

  function explainHand(handKey, action) {
    const isPair = handKey.length === 2;
    const suited = handKey.endsWith('s');
    const topRank = handKey[0];
    if (action === 'raise' && isPair && (topRank === 'A' || topRank === 'K' || topRank === 'Q')) {
      return 'Premium pairs are almost always a raise regardless of position.';
    }
    if (action === 'raise') return 'Strong enough to apply pressure and build the pot proactively.';
    if (action === 'call' && suited) return 'Playable for a call - suited cards add flush/straight potential worth continuing with.';
    if (action === 'call') return 'Not strong enough to raise here, but live enough to see a flop.';
    return 'Too weak to continue in this spot - folding preserves chips for a better one.';
  }

  function randomHoleCards() {
    const deck = [];
    for (const s of TRAINER_SUITS) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
    for (let i = 0; i < 2; i++) {
      const j = i + Math.floor(Math.random() * (deck.length - i));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    return [deck[0], deck[1]];
  }

  function toHandKey(c1, c2) {
    if (c1.rank === c2.rank) return RANK_LETTER[c1.rank] + RANK_LETTER[c1.rank];
    const hi = c1.rank > c2.rank ? c1 : c2;
    const lo = c1.rank > c2.rank ? c2 : c1;
    return RANK_LETTER[hi.rank] + RANK_LETTER[lo.rank] + (c1.suit === c2.suit ? 's' : 'o');
  }

  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Exposed for the data-integrity test (Node's vm module loads this file and
  // inspects window.RangeTrainer directly, without a DOM).
  const RangeTrainer = { RANGE_DATA, chenScore, toHandKey, buildRangeData, POSITIONS, SCENARIOS };
  if (typeof window !== 'undefined') window.RangeTrainer = RangeTrainer;
  if (typeof module !== 'undefined' && module.exports) module.exports = RangeTrainer;

  // ===== UI wiring (no-op if this file is loaded outside a page with these elements) =====
  if (typeof document === 'undefined' || !document.getElementById('trainer-modal')) return;

  let trainerState = null;
  let trainerReps = 0;
  let trainerCorrect = 0;

  function newTrainerRep() {
    const position = pickRandom(POSITIONS);
    const scenario = pickRandom(SCENARIOS);
    const cards = randomHoleCards();
    const handKey = toHandKey(cards[0], cards[1]);
    const entry = RANGE_DATA[scenario][position][handKey];
    trainerState = { position, scenario, cards, handKey, entry };

    document.getElementById('trainer-scenario').textContent = scenarioText(scenario, position);
    document.getElementById('trainer-hand').innerHTML = cards.map((c) => cHTML(c)).join('');
    const fb = document.getElementById('trainer-feedback');
    fb.classList.add('hidden');
    fb.className = 'hidden';
    document.getElementById('btn-trainer-next').classList.add('hidden');
    document.getElementById('trainer-actions').classList.remove('hidden');
    // RFI has no bet to call - hide the Call button rather than offering a nonsensical option
    document.getElementById('btn-trainer-call').style.display = scenario === 'RFI' ? 'none' : '';
  }

  function gradeTrainerAction(userAction) {
    if (!trainerState) return;
    const { entry, handKey } = trainerState;
    const correct = userAction === entry.action || userAction === entry.altAction;
    trainerReps++;
    if (correct) trainerCorrect++;

    document.getElementById('tr-reps').textContent = trainerReps;
    document.getElementById('tr-correct').textContent = trainerCorrect;
    document.getElementById('tr-accuracy').textContent = Math.round((trainerCorrect / trainerReps) * 100) + '%';

    const fb = document.getElementById('trainer-feedback');
    fb.classList.remove('hidden');
    fb.className = correct ? 'correct' : 'incorrect';
    const verdict = correct ? '✓ Correct' : '✗ Not quite';
    fb.innerHTML =
      '<span class="tf-verdict">' + verdict + '</span>' +
      'Reference play: <strong>' + entry.action.toUpperCase() + '</strong> with ' + handKey + '. ' +
      explainHand(handKey, entry.action);

    document.getElementById('trainer-actions').classList.add('hidden');
    document.getElementById('btn-trainer-next').classList.remove('hidden');
  }

  document.getElementById('btn-trainer-fold').addEventListener('click', () => gradeTrainerAction('fold'));
  document.getElementById('btn-trainer-call').addEventListener('click', () => gradeTrainerAction('call'));
  document.getElementById('btn-trainer-raise').addEventListener('click', () => gradeTrainerAction('raise'));
  document.getElementById('btn-trainer-next').addEventListener('click', () => newTrainerRep());

  document.getElementById('btn-open-trainer').addEventListener('click', () => {
    document.getElementById('trainer-modal').classList.remove('hidden');
    newTrainerRep();
  });
  document.getElementById('btn-close-trainer').addEventListener('click', () => {
    document.getElementById('trainer-modal').classList.add('hidden');
  });
})();
