// ===== Bot Mascots =====
// A small named character + simple drawn avatar per difficulty tier, purely
// to make picking a difficulty feel more fun - not tied to any real person,
// same "simple, drawn, no external art" approach already used for the rank
// badges.

(function () {
  const MASCOT_INFO = {
    easy: { name: 'Lucky Lenny', color: '#66bb6a', accent: '#2e7d32', mouth: 'M 10 21 Q 16 27 22 21' },
    medium: { name: 'Steady Sam', color: '#ffca28', accent: '#b28900', mouth: 'M 10 23 L 22 23' },
    hard: { name: 'Sharp Suzanne', color: '#ef5350', accent: '#b71c1c', mouth: 'M 10 24 Q 16 20 22 24' },
    expert: { name: 'The Professor', color: '#e0e0e0', accent: '#9e9e9e', mouth: 'M 10 23 L 22 23', glasses: true },
    drunk: { name: 'Wobbly Walt', color: '#ff8a65', accent: '#bf360c', mouth: 'M 9 21 Q 12 25 15 21 Q 18 17 22 22', crooked: true },
    bluffer: { name: 'Sly Sadie', color: '#ab47bc', accent: '#6a1b9a', mouth: 'M 10 22 Q 16 24 22 19', wink: true },
    rock: { name: 'The Rock', color: '#78909c', accent: '#37474f', mouth: 'M 11 22 L 21 22' },
    maniac: { name: 'The Maniac', color: '#ff5252', accent: '#8e0000', mouth: 'M 9 20 Q 16 28 23 20', crooked: true },
    tycoon: { name: 'The Tycoon', color: '#ffd54f', accent: '#c79100', mouth: 'M 9 21 Q 16 26 23 21', glasses: true },
    schemer: { name: 'The Schemer', color: '#7e57c2', accent: '#4527a0', mouth: 'M 10 22 Q 16 24 22 19', wink: true },
    conspiracy: { name: 'The Conspiracy Guy', color: '#8d6e63', accent: '#4e342e', mouth: 'M 10 23 Q 16 20 22 23', crooked: true },
    socialite: { name: 'The Socialite', color: '#f06292', accent: '#ad1457', mouth: 'M 10 21 Q 16 26 22 21' },
    veteran: { name: 'The Veteran', color: '#a1887f', accent: '#5d4037', mouth: 'M 10 23 L 22 23', glasses: true },
    newcomer: { name: 'The Newcomer', color: '#81c784', accent: '#388e3c', mouth: 'M 9 20 Q 16 27 23 20' },
  };

  function renderMascotAvatar(diffKey, size) {
    size = size || 40;
    const info = MASCOT_INFO[diffKey] || MASCOT_INFO.easy;
    let eyes;
    if (info.glasses) {
      eyes = '<circle cx="11" cy="15" r="4" fill="none" stroke="#2a2a2a" stroke-width="1.4"/>' +
        '<circle cx="21" cy="15" r="4" fill="none" stroke="#2a2a2a" stroke-width="1.4"/>' +
        '<line x1="15" y1="15" x2="17" y2="15" stroke="#2a2a2a" stroke-width="1.4"/>';
    } else if (info.wink) {
      eyes = '<circle cx="11" cy="14" r="1.6" fill="#2a2a2a"/>' +
        '<path d="M 19 14 Q 21 12.5 23 14" stroke="#2a2a2a" stroke-width="1.4" fill="none" stroke-linecap="round"/>';
    } else if (info.crooked) {
      eyes = '<circle cx="10.5" cy="13" r="1.7" fill="#2a2a2a"/>' +
        '<circle cx="21.5" cy="15.5" r="1.7" fill="#2a2a2a"/>';
    } else {
      eyes = '<circle cx="11" cy="14" r="1.6" fill="#2a2a2a"/>' +
        '<circle cx="21" cy="14" r="1.6" fill="#2a2a2a"/>';
    }

    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" class="mascot-avatar-svg">' +
      '<circle cx="16" cy="16" r="15" fill="' + info.color + '" stroke="' + info.accent + '" stroke-width="1.5"/>' +
      eyes +
      '<path d="' + info.mouth + '" stroke="#2a2a2a" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function mascotName(diffKey) {
    const info = MASCOT_INFO[diffKey];
    return info ? info.name : '';
  }

  const BotMascots = { render: renderMascotAvatar, nameFor: mascotName, MASCOT_INFO };
  if (typeof window !== 'undefined') window.BotMascots = BotMascots;
  if (typeof module !== 'undefined' && module.exports) module.exports = BotMascots;

  // Self-mounts into any difficulty box markup present on the page - a no-op
  // if this file is loaded somewhere without these elements (e.g. under test).
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.diff-box-avatar[data-mascot]').forEach((el) => {
    el.innerHTML = renderMascotAvatar(el.dataset.mascot, 40);
  });
  document.querySelectorAll('.diff-box-mascot-name[data-mascot]').forEach((el) => {
    el.textContent = mascotName(el.dataset.mascot);
  });
})();
