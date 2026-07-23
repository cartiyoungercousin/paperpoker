// Card ranks: 2-10 are their number, 11=J, 12=Q, 13=K, 14=A.
// Suits: 'h' (hearts), 'd' (diamonds), 'c' (clubs), 's' (spades).

const SUITS = ["h", "d", "c", "s"];
const RANK_NAMES = {
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export function rankName(rank) {
  return RANK_NAMES[rank] || String(rank);
}

export function cardToString(card) {
  return `${rankName(card.rank)}${card.suit}`;
}

export class Deck {
  constructor() {
    this.cards = [];
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) {
        this.cards.push({ rank, suit });
      }
    }
  }

  // Fisher-Yates shuffle. Pass a seeded RNG function for reproducible tests.
  shuffle(rng = Math.random) {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    return this;
  }

  draw(n = 1) {
    if (n > this.cards.length) {
      throw new Error("Not enough cards left in the deck");
    }
    return this.cards.splice(0, n);
  }

  remaining() {
    return this.cards.length;
  }
}
