// ===== Learning Center =====
// A standalone, static content page (no server/socket involvement) that
// teaches the rules of Texas Hold'em, betting terminology, player-style
// archetypes, and this app's own session-stat glossary, then renders a
// classic 13x13 starting-hand equity matrix reusing the Chen Formula scorer
// already built and tested for the Range Trainer tab (window.RangeTrainer),
// rather than re-deriving hand strength a second time.

(function () {
  if (typeof document === 'undefined' || !document.getElementById('page-learn')) return;

  const HAND_RANKINGS = [
    { name: 'Royal Flush', cards: [[14, 's'], [13, 's'], [12, 's'], [11, 's'], [10, 's']], desc: 'The ace-high straight flush. The single best hand in poker.' },
    { name: 'Straight Flush', cards: [[9, 'h'], [8, 'h'], [7, 'h'], [6, 'h'], [5, 'h']], desc: 'Five cards in sequence, all the same suit.' },
    { name: 'Four of a Kind', cards: [[13, 's'], [13, 'h'], [13, 'd'], [13, 'c'], [4, 'c']], desc: 'All four cards of one rank, plus any fifth card.' },
    { name: 'Full House', cards: [[13, 's'], [13, 'h'], [13, 'd'], [7, 'c'], [7, 's']], desc: 'Three of a kind combined with a separate pair.' },
    { name: 'Flush', cards: [[14, 'c'], [11, 'c'], [8, 'c'], [5, 'c'], [2, 'c']], desc: 'Five cards of the same suit, not in sequence.' },
    { name: 'Straight', cards: [[9, 's'], [8, 'h'], [7, 'd'], [6, 'c'], [5, 's']], desc: 'Five cards in sequence, mixed suits.' },
    { name: 'Three of a Kind', cards: [[8, 's'], [8, 'h'], [8, 'd'], [13, 'c'], [2, 's']], desc: 'Three cards of one rank, plus two unrelated cards.' },
    { name: 'Two Pair', cards: [[11, 's'], [11, 'h'], [4, 'd'], [4, 'c'], [9, 's']], desc: 'Two separate pairs, plus any fifth card.' },
    { name: 'One Pair', cards: [[10, 's'], [10, 'h'], [13, 'd'], [6, 'c'], [3, 's']], desc: 'Two cards of one rank, plus three unrelated cards.' },
    { name: 'High Card', cards: [[14, 's'], [11, 'h'], [8, 'd'], [6, 'c'], [2, 's']], desc: 'No pair or better. The highest card plays.' },
  ];

  const PLAY_STYLES = [
    {
      name: 'Tight-Aggressive (TAG)',
      tag: 'Tight + Aggressive',
      desc: 'Plays a narrow, selective range of starting hands, but bets and raises those hands hard rather than just calling. Widely considered the strongest baseline style, since a bet almost always means real strength and that makes it hard to read.',
    },
    {
      name: 'Loose-Aggressive (LAG)',
      tag: 'Loose + Aggressive',
      desc: 'Plays a wide range of hands and applies pressure with bets and raises on most of them. Difficult to play against because a bet could mean anything, but it is also higher variance and easier to misplay.',
    },
    {
      name: 'Tight-Passive ("Rock")',
      tag: 'Tight + Passive',
      desc: 'Plays few hands and mostly calls rather than raises, even with strong holdings. Predictable and easy to read, so when a Rock finally raises, it almost always means a premium hand.',
    },
    {
      name: 'Loose-Passive ("Calling Station")',
      tag: 'Loose + Passive',
      desc: 'Plays too many hands and rarely folds or raises, preferring to call bets down. Bleeds chips slowly over time instead of losing them all at once, and bluffing a Calling Station rarely works.',
    },
    {
      name: 'Maniac',
      tag: 'Extreme LAG',
      desc: 'An exaggerated Loose-Aggressive player who bets and raises almost constantly, regardless of hand strength. Wildly unpredictable, and capable of huge upswings and huge downswings in the same session.',
    },
  ];

  const POKER_TERMS = [
    { term: 'Check-Raise', desc: 'Checking with the intention of raising once someone else bets. A classic trap play against opponents who bet whenever they get the chance.' },
    { term: '3-Bet', desc: 'The third bet in a preflop sequence: someone opens with a raise (the first bet), you re-raise (the second raise, but the third bet overall counting the blind). A 3-bet usually represents a stronger range than a plain open-raise.' },
    { term: 'C-Bet (Continuation Bet)', desc: 'A bet on the flop made by whoever raised preflop, continuing the aggression regardless of whether the flop actually improved their hand.' },
    { term: 'Pot Odds', desc: 'The price you are getting to call, expressed as a ratio of the call amount to the resulting pot. If the pot is $80 and you must call $20 to see the next card, you are calling $20 to win $100, which is 20%. If your chance to win the hand is better than that 20%, calling shows a profit over time.' },
    { term: 'Pot-Committed', desc: 'A situation where you have already put in so much of your stack that folding no longer makes sense, even with a mediocre hand, because the pot odds to call are simply too good.' },
    { term: 'The Nuts', desc: 'The best possible hand given the current board. Having the nuts means no other hand can beat you.' },
    { term: 'Value Bet', desc: 'Betting a strong hand specifically to get called by something worse, rather than to make everyone fold.' },
    { term: 'Slow Play', desc: 'Underplaying a very strong hand on purpose (checking or just calling) to keep opponents in the pot and let them build it for you.' },
    { term: 'Position', desc: 'Where you sit relative to the dealer button. Acting later than your opponents (being "in position") is a real, persistent advantage, since you get to see their decision before making yours.' },
    { term: 'Runout', desc: 'The remaining community cards still to come. "The runout was bad for me" just means the later cards helped an opponent more than they helped you.' },
  ];

  const STAT_GLOSSARY = [
    { name: 'VPIP', full: 'Voluntarily Put $ In Pot', desc: 'The percentage of hands where you chose to put chips in preflop, by calling or raising, not counting simply posting a blind. Higher VPIP means a looser, wider preflop range.' },
    { name: 'PFR %', full: 'Preflop Raise %', desc: 'The percentage of hands where you raised preflop. Comparing PFR to VPIP shows how aggressively you play your range: numbers close together mean you mostly raise when you enter a pot, while a big gap means you mostly just call.' },
    { name: '3-Bet %', full: 'Three-Bet %', desc: 'Of the times you faced a preflop raise and had the option to re-raise, the percentage of the time you did. A read on how often you apply preflop pressure rather than just calling or folding.' },
    { name: 'Aggression Factor', full: '(Bets + Raises) / Calls', desc: 'A single number summarizing betting style across the whole session. Above 1 means you bet or raise more often than you call. The higher it climbs, the more it signals an aggressive or LAG-leaning style, while a low number signals a passive style.' },
    { name: 'Fold %', full: 'Fold % of all actions', desc: 'The percentage of every action you took this session, across every street, that was a fold.' },
    { name: 'WTSD %', full: 'Went To Showdown %', desc: 'Of the hands you were dealt into, the percentage where you personally stayed in all the way to showdown instead of folding first.' },
    { name: 'W$SD %', full: 'Won $ at Showdown %', desc: 'Of the hands you actually reached showdown in, the percentage you won. A low number despite a reasonable WTSD often means you are going to showdown with hands too weak to win.' },
    { name: 'Net Profit', full: 'Total Winnings minus Total Invested', desc: 'The straightforward bottom line for the session: everything you have won, minus everything you have put into pots.' },
    { name: 'ROI', full: 'Return on Investment', desc: 'Net Profit divided by Total Invested, shown as a percentage. Measures efficiency rather than raw dollars, which is useful for comparing sessions with different stakes or lengths.' },
    { name: 'All-In Equity / Luck', full: 'Luck-Adjusted EV', desc: 'For hands where every remaining player got all-in before the river, the app calculates your exact mathematical share of that pot by enumerating or simulating every possible runout. The gap between what you actually won and that fair share is luck, good or bad, isolated from the quality of your decisions.' },
  ];

  const TOC = [
    { id: 'lp-rankings', label: 'Hand Rankings' },
    { id: 'lp-flow', label: 'How a Hand Is Played' },
    { id: 'lp-positions', label: 'Positions & Blinds' },
    { id: 'lp-actions', label: 'Betting Actions' },
    { id: 'lp-terms', label: 'Poker Terms' },
    { id: 'lp-styles', label: 'Play Styles' },
    { id: 'lp-glossary', label: 'Stat Glossary' },
    { id: 'lp-using', label: 'Using This App' },
    { id: 'lp-equity', label: 'Equity Matrix' },
  ];

  function rankCardsHTML(cards) {
    return '<div class="lp-rank-cards">' + cards.map((rc) => window.cHTML({ rank: rc[0], suit: rc[1] })).join('') + '</div>';
  }

  function handRankingsHTML() {
    return HAND_RANKINGS.map((h, i) => (
      '<div class="lp-rank-row">' +
        '<div class="lp-rank-num">' + (i + 1) + '</div>' +
        rankCardsHTML(h.cards) +
        '<div class="lp-rank-body">' +
          '<div class="lp-rank-name">' + h.name + '</div>' +
          '<div class="lp-rank-desc">' + h.desc + '</div>' +
        '</div>' +
      '</div>'
    )).join('');
  }

  function playStylesHTML() {
    return PLAY_STYLES.map((s) => (
      '<div class="lp-style-card">' +
        '<div class="lp-style-tag">' + s.tag + '</div>' +
        '<div class="lp-style-name">' + s.name + '</div>' +
        '<div class="lp-style-desc">' + s.desc + '</div>' +
      '</div>'
    )).join('');
  }

  function pokerTermsHTML() {
    return POKER_TERMS.map((t) => (
      '<div class="lp-term-row">' +
        '<div class="lp-term-name">' + t.term + '</div>' +
        '<div class="lp-term-desc">' + t.desc + '</div>' +
      '</div>'
    )).join('');
  }

  function statGlossaryHTML() {
    return STAT_GLOSSARY.map((s) => (
      '<div class="lp-stat-row">' +
        '<div class="lp-stat-name">' + s.name + '<span class="lp-stat-full">' + s.full + '</span></div>' +
        '<div class="lp-stat-desc">' + s.desc + '</div>' +
      '</div>'
    )).join('');
  }

  function tocHTML() {
    return TOC.map((t) => '<a href="#' + t.id + '" class="lp-toc-link">' + t.label + '</a>').join('');
  }

  const PAGE_HTML =
    '<div id="learn-content">' +
      '<h1 class="site-page-title">Learning Center</h1>' +
      '<p id="learn-intro">A plain-language guide to how Texas Hold\'em works, how to read a player, and what every stat in this app actually measures.</p>' +
      '<nav id="lp-toc">' + tocHTML() + '</nav>' +

      '<section id="lp-rankings" class="lp-section">' +
        '<h2 class="lp-section-title">Hand Rankings</h2>' +
        '<p class="lp-section-sub">Best to worst. Your final hand is always the best 5 cards you can make from your 2 hole cards and the 5 community cards.</p>' +
        '<div id="lp-rank-list">' + handRankingsHTML() + '</div>' +
      '</section>' +

      '<section id="lp-flow" class="lp-section">' +
        '<h2 class="lp-section-title">How a Hand Is Played</h2>' +
        '<div class="lp-flow-grid">' +
          '<div class="lp-flow-step"><div class="lp-flow-label">Preflop</div><p>Every player is dealt 2 private hole cards. Betting starts with the player after the Big Blind and goes around the table once.</p></div>' +
          '<div class="lp-flow-step"><div class="lp-flow-label">Flop</div><p>3 community cards are dealt face up in the middle. A new betting round starts with the first active player left of the button.</p></div>' +
          '<div class="lp-flow-step"><div class="lp-flow-label">Turn</div><p>A 4th community card is dealt. Another full betting round follows.</p></div>' +
          '<div class="lp-flow-step"><div class="lp-flow-label">River</div><p>The 5th and final community card is dealt, followed by the last betting round.</p></div>' +
          '<div class="lp-flow-step"><div class="lp-flow-label">Showdown</div><p>If two or more players are still in, remaining hands are revealed and the best 5-card hand wins the pot. If everyone but one player folds at any point, that player wins without a showdown.</p></div>' +
        '</div>' +
      '</section>' +

      '<section id="lp-positions" class="lp-section">' +
        '<h2 class="lp-section-title">Positions & Blinds</h2>' +
        '<p>The <strong>dealer button</strong> is a marker that rotates one seat clockwise every hand, deciding betting order. The two players immediately left of the button post forced bets before any cards are dealt, to seed the pot:</p>' +
        '<ul class="lp-list">' +
          '<li><strong>Small Blind (SB)</strong>: posts a partial forced bet, acts first after the flop.</li>' +
          '<li><strong>Big Blind (BB)</strong>: posts a full forced bet, gets the option to raise even with no other action preflop.</li>' +
        '</ul>' +
        '<p>Everyone else is described by how far they sit from the button. <strong>Early position</strong> acts first with the least information, so it pays to play tight there. <strong>Middle position</strong> sits in between. <strong>Late position</strong>, the Cutoff and the Button itself, act last on every postflop street and get to see everyone else\'s action before deciding, which is why late-position ranges are much wider than early-position ranges. This is exactly what the <strong>Range Trainer</strong> tab drills.</p>' +
      '</section>' +

      '<section id="lp-actions" class="lp-section">' +
        '<h2 class="lp-section-title">Betting Actions</h2>' +
        '<div class="lp-actions-grid">' +
          '<div class="lp-action-card"><div class="lp-action-name">Fold</div><p>Give up the hand and forfeit any chips already put in.</p></div>' +
          '<div class="lp-action-card"><div class="lp-action-name">Check</div><p>Pass the action without betting. Only possible if no one has bet yet this round.</p></div>' +
          '<div class="lp-action-card"><div class="lp-action-name">Call</div><p>Match the current bet to stay in the hand.</p></div>' +
          '<div class="lp-action-card"><div class="lp-action-name">Bet</div><p>Put chips in when no one else has bet yet this round.</p></div>' +
          '<div class="lp-action-card"><div class="lp-action-name">Raise</div><p>Increase an existing bet, forcing everyone else to match the new, higher amount to continue.</p></div>' +
          '<div class="lp-action-card"><div class="lp-action-name">All-In</div><p>Bet every remaining chip. Once every live player is all-in, the rest of the hand runs out with no more betting.</p></div>' +
        '</div>' +
      '</section>' +

      '<section id="lp-terms" class="lp-section">' +
        '<h2 class="lp-section-title">Poker Terms</h2>' +
        '<p class="lp-section-sub">A few more terms worth knowing beyond the basic actions above, including a plain-English walkthrough of pot odds.</p>' +
        '<div id="lp-terms-list">' + pokerTermsHTML() + '</div>' +
      '</section>' +

      '<section id="lp-styles" class="lp-section">' +
        '<h2 class="lp-section-title">Play Styles</h2>' +
        '<p class="lp-section-sub">Two independent traits describe almost every player: how many hands they play (tight vs. loose), and how they play them (passive vs. aggressive). This app\'s bots are built from these same archetypes.</p>' +
        '<div id="lp-styles-grid">' + playStylesHTML() + '</div>' +
      '</section>' +

      '<section id="lp-glossary" class="lp-section">' +
        '<h2 class="lp-section-title">Stat Glossary</h2>' +
        '<p class="lp-section-sub">Exactly what the Stats panel measures, in the same terms the game itself uses.</p>' +
        '<div id="lp-glossary-list">' + statGlossaryHTML() + '</div>' +
      '</section>' +

      '<section id="lp-using" class="lp-section">' +
        '<h2 class="lp-section-title">Using This App</h2>' +
        '<p class="lp-section-sub">How the pieces fit together, if you want to actually improve rather than just play.</p>' +
        '<div class="lp-using-grid">' +
          '<div class="lp-using-card"><div class="lp-using-name">Start with Range Trainer</div><p>Before worrying about betting strategy, get comfortable with which starting hands are worth playing from which position. The Range Trainer tab drills this in isolation, hand by hand, with instant feedback.</p></div>' +
          '<div class="lp-using-card"><div class="lp-using-name">Play a session</div><p>Take what you drilled into an actual game against bots of whatever difficulty suits you. The Stats panel (open it from the in-game header) tracks VPIP, PFR, aggression, and more as you play, so patterns in your own game become visible in real numbers instead of just a feeling.</p></div>' +
          '<div class="lp-using-card"><div class="lp-using-name">Review the replay</div><p>After any hand, the Hand Analyzer lets you step back through every street and see the equity and pot odds you were actually facing at each decision, not just the result. This is where the Stat Glossary above becomes useful again: once you know what a term means, seeing it applied to your own hand is what makes it stick.</p></div>' +
        '</div>' +
      '</section>' +

      '<section id="lp-equity" class="lp-section">' +
        '<h2 class="lp-section-title">Equity Matrix</h2>' +
        '<p class="lp-section-sub">All 169 possible starting hands, colored by Chen Formula score, the same quick point system the Range Trainer tab uses to rank hand strength. Pairs run down the diagonal, suited combinations sit above it, offsuit combinations sit below it. Brighter cells are stronger.</p>' +
        '<div id="lp-equity-wrap">' +
          '<div id="lp-equity-matrix"></div>' +
          '<div id="lp-equity-legend"><span>Weak</span><div id="lp-equity-legend-bar"></div><span>Strong</span></div>' +
        '</div>' +
      '</section>' +
    '</div>';

  const container = document.getElementById('learn-placeholder') || document.getElementById('page-learn');
  container.outerHTML = '<div id="page-learn-body">' + PAGE_HTML + '</div>';

  // Smooth in-page scrolling for the table of contents (scrolls within the
  // .site-page's own overflow-y:auto container, not the whole document).
  document.querySelectorAll('#lp-toc .lp-toc-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ===== Equity Matrix rendering =====
  // Reuses window.RangeTrainer.chenScore (already unit-tested against known
  // reference values) instead of re-deriving hand-strength scoring here.
  const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const LETTERS = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
  const MAX_CHEN_SCORE = 20; // AA

  function chenColor(score) {
    const t = Math.max(0, Math.min(1, score / MAX_CHEN_SCORE));
    const r = Math.round(90 + t * (201 - 90));
    const g = Math.round(40 + t * (168 - 40));
    const b = Math.round(40 + t * (76 - 40));
    return { bg: 'rgb(' + r + ',' + g + ',' + b + ')', dark: t > 0.5 };
  }

  function renderEquityMatrix() {
    const rt = window.RangeTrainer;
    const matrixEl = document.getElementById('lp-equity-matrix');
    if (!rt || !matrixEl) return;
    let html = '';
    for (let i = 0; i < RANKS.length; i++) {
      for (let j = 0; j < RANKS.length; j++) {
        const rowRank = RANKS[i], colRank = RANKS[j];
        let key, score;
        if (i === j) {
          key = LETTERS[rowRank] + LETTERS[rowRank];
          score = rt.chenScore(rowRank, rowRank, false);
        } else if (i < j) {
          key = LETTERS[rowRank] + LETTERS[colRank] + 's';
          score = rt.chenScore(rowRank, colRank, true);
        } else {
          key = LETTERS[colRank] + LETTERS[rowRank] + 'o';
          score = rt.chenScore(colRank, rowRank, false);
        }
        const c = chenColor(score);
        html += '<div class="lp-eq-cell" style="background:' + c.bg + ';color:' + (c.dark ? '#1a1108' : '#f0ece2') + '" title="' + key + ', Chen score ' + score + '">' + key + '</div>';
      }
    }
    matrixEl.innerHTML = html;
  }

  renderEquityMatrix();
})();
