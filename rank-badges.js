// ===== Rank Badges =====
// Renders the 6 rank-tier badges (Bronze/Silver/Gold/PokerAddict/PokerStar/
// PokerProfessor) as small inline SVGs - no external art assets, matching
// each tier's identity with a distinct gradient/rim treatment. Reused
// wherever a rank needs to show up: the site header, and (later) seat
// displays and the leaderboard.

(function () {
  const TIER_COLORS = {
    bronze: { from: '#c17a42', to: '#7a4a24', rim: '#8a5a30' },
    silver: { from: '#e4e8ec', to: '#9aa0a6', rim: '#7a8086' },
    gold: { from: '#ffe27a', to: '#c9a84c', rim: '#a8863a' },
    pokeraddict: { from: '#c084e8', to: '#6c3483', rim: '#4a2361' },
    pokerstar: { from: '#3a3a3a', to: '#000000', rim: '#c9a84c' },
    pokerprofessor: { from: '#7a7a7a', to: '#232323', rim: 'prismatic' },
  };

  const ROMAN = { 3: 'III', 2: 'II', 1: 'I' };

  let uidCounter = 0;

  // tierKey: 'bronze'|'silver'|'gold'|'pokeraddict'|'pokerstar'|'pokerprofessor'
  // sub: 3|2|1|null (null for the single-level PokerProfessor tier)
  function renderRankBadge(tierKey, sub, size) {
    size = size || 32;
    const colors = TIER_COLORS[tierKey] || TIER_COLORS.bronze;
    const uid = 'rb' + (uidCounter++);
    const gradId = uid + '-grad';
    const rimId = uid + '-rim';

    let rimStroke = colors.rim;
    let rimDefs = '';
    if (colors.rim === 'prismatic') {
      rimDefs =
        '<linearGradient id="' + rimId + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" stop-color="#ff5f6d"/>' +
        '<stop offset="20%" stop-color="#ffc371"/>' +
        '<stop offset="40%" stop-color="#7afcff"/>' +
        '<stop offset="60%" stop-color="#6a82fb"/>' +
        '<stop offset="80%" stop-color="#fc5c7d"/>' +
        '<stop offset="100%" stop-color="#ff5f6d"/>' +
        '</linearGradient>';
      rimStroke = 'url(#' + rimId + ')';
    }

    const icon = tierKey === 'pokerprofessor'
      ? '<text x="50%" y="56%" text-anchor="middle" font-size="' + (size * 0.5) + '" dominant-baseline="middle">🎓</text>'
      : (sub ? '<text x="50%" y="66%" text-anchor="middle" font-family="Inter, sans-serif" font-size="' + (size * 0.26) + '" font-weight="700" fill="rgba(0,0,0,0.4)">' + ROMAN[sub] + '</text>' : '');

    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" class="rank-badge-svg">' +
      '<defs>' +
      '<radialGradient id="' + gradId + '" cx="35%" cy="30%" r="75%">' +
      '<stop offset="0%" stop-color="' + colors.from + '"/>' +
      '<stop offset="100%" stop-color="' + colors.to + '"/>' +
      '</radialGradient>' +
      rimDefs +
      '</defs>' +
      '<circle cx="50%" cy="50%" r="' + (size / 2 - 1.5) + '" fill="url(#' + gradId + ')" stroke="' + rimStroke + '" stroke-width="2"/>' +
      icon +
      '</svg>'
    );
  }

  const RankBadges = { render: renderRankBadge };
  if (typeof window !== 'undefined') window.RankBadges = RankBadges;
  if (typeof module !== 'undefined' && module.exports) module.exports = RankBadges;
})();
